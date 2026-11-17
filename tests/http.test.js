import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpGate,
  robotsRules,
  robotsAllowed,
  retryAfter,
  scheduleRetry,
} from '../collector/http.js';

const origin = 'https://www.kanjipedia.jp';

function mockGate(responses, options = {}) {
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const starts = [],
    saves = [];
  const state = {
    robots: {
      [origin]: { ...robotsRules('User-agent:*\nDisallow:'), checkedAt: clock },
    },
  };
  const gate = new HttpGate({
    state,
    now: () => clock,
    random: () => 0,
    sleep: async (ms) => {
      clock += ms;
    },
    save: async (s) => {
      saves.push(structuredClone(s));
    },
    request: async (url, options) => {
      assert.ok(responses.length, `予定外のHTTP要求: ${url}`);
      starts.push({ at: clock, url, options });
      clock += 2000;

      const next = responses.shift();

      if (next instanceof Error) throw next;

      if (typeof next === 'function') return next(url, options);

      return new Response(next?.body ?? 'ok', {
        status: next?.status ?? 200,
        headers: next?.headers,
      });
    },
    ...options,
  });

  return {
    gate,
    starts,
    saves,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('すべての要求を応答終了から10秒以上空けて直列実行し、要求数を永続化する', async () => {
  const { gate, starts, saves } = mockGate([{}, {}]);

  await gate.get(`${origin}/search`);
  await gate.get(`${origin}/robots.txt`, { robots: false });

  assert.equal(starts[1].at - starts[0].at, 12_000);
  assert.equal(gate.state.count, 2);
  assert.ok(saves[0].nextAt >= saves[0].lastAt + 40_000);
  assert.ok(starts[0].options.signal instanceof AbortSignal);
  assert.equal(starts[0].options.redirect, 'manual');
});

for (const [label, response, reason] of [
  ['401', { status: 401 }, 'Access blocked: HTTP 401'],
  ['403', { status: 403 }, 'Access blocked: HTTP 403'],
  ['404', { status: 404 }, 'Unexpected/empty response: HTTP 404'],
  ['空の200', { body: '' }, 'Unexpected/empty response: HTTP 200'],
  [
    '200のブロック画面',
    { body: '<h1>CAPTCHA</h1>' },
    'Access blocked: HTTP 200',
  ],
]) {
  test(`${label}は再試行可能にせず、応答と停止理由を保存する`, async () => {
    const recorded = [];
    const { gate, starts, saves } = mockGate([response], {
      recordResponse: async (result) => recorded.push(result),
    });

    await assert.rejects(gate.get(`${origin}/x`), { code: 3, message: reason });
    assert.equal(starts.length, 1);
    assert.equal(saves.at(-1).count, 1);
    assert.equal(recorded[0].status, response.status ?? 200);
    assert.equal(recorded[0].body, response.body ?? 'ok');
  });
}

test('UTC日次上限の直前の1要求を許可し、翌UTC日に枠を更新する', async () => {
  const { gate, starts, advance } = mockGate([{}, {}]);
  gate.state.day = '2026-11-15';
  gate.state.count = 499;

  await gate.get(`${origin}/x`);
  await assert.rejects(gate.get(`${origin}/x`), {
    code: 2,
    message: 'UTC daily limit reached',
  });
  assert.equal(starts.length, 1);
  assert.equal(gate.state.count, 500);

  advance(86_400_000 - 12_000);
  await gate.get(`${origin}/x`);

  assert.equal(starts[1].at, Date.parse('2026-11-16T00:00:00Z'));
  assert.equal(gate.state.day, '2026-11-16');
  assert.equal(gate.state.count, 1);
});

test('応答本文を読み終えるまで次の要求を許可せず、本文完了時から間隔を空ける', async () => {
  const body = Promise.withResolvers();
  const reading = Promise.withResolvers();
  const { gate, starts, advance } = mockGate([
    () => ({
      status: 200,
      headers: new Headers(),
      text: () => {
        reading.resolve();
        return body.promise;
      },
    }),
    {},
  ]);
  const first = gate.get(`${origin}/x`);
  await reading.promise;

  await assert.rejects(gate.get(`${origin}/x`), {
    code: 3,
    message: 'Concurrent request rejected',
  });
  advance(5_000);
  body.resolve('本文');
  await first;
  await gate.get(`${origin}/x`);

  assert.equal(starts[1].at - starts[0].at, 17_000);
});

test('冷却期限のちょうどその時刻から要求を再開できる', async () => {
  const { gate, starts, advance } = mockGate([
    { status: 429, headers: { 'retry-after': '1200' } },
    {},
  ]);

  await assert.rejects(gate.get(`${origin}/x`), { code: 3 });
  advance(1_200_000 - 1);
  await assert.rejects(gate.get(`${origin}/x`), /Cooling down/);
  assert.equal(starts.length, 1);

  advance(1);
  assert.equal((await gate.get(`${origin}/x`)).status, 200);
  assert.equal(gate.state.count, 2);
});

for (const [label, nextOffset, random, expectedOffset] of [
  ['1回目の再試行にジッターを加える', 0, 0.5, 62_500],
  ['予約済みの長い待機を短縮しない', 300_000, 0, 300_000],
]) {
  test(`${label}待機を保存し、ゲートを作り直しても維持する`, async () => {
    const { gate } = mockGate([], { random: () => random });
    const now = gate.now();
    gate.state.nextAt = now + nextOffset;
    await scheduleRetry(gate, 1);

    const { gate: resumed, starts } = mockGate([{}], {
      state: structuredClone(gate.state),
    });
    await resumed.get(`${origin}/x`);

    assert.equal(starts[0].at, now + expectedOffset);
  });
}

test('要求枠の永続化に失敗したらHTTPを送らない', async () => {
  const failure = new Error('カウンター保存失敗');
  const { gate, starts } = mockGate([{}], {
    save: async () => {
      throw failure;
    },
  });

  await assert.rejects(gate.get(`${origin}/x`), failure);
  assert.equal(starts.length, 0);
});

test('失敗の間に正常応答があれば連続失敗数をリセットする', async () => {
  const { gate } = mockGate([{ status: 500 }, {}, { status: 500 }]);

  await assert.rejects(gate.get(`${origin}/x`), { retryable: true });
  await gate.get(`${origin}/x`);
  await assert.rejects(gate.get(`${origin}/x`), { retryable: true });

  assert.equal(gate.state.consecutiveFailures, 1);
  assert.equal(gate.state.count, 3);
});

test('並行要求・日次上限・1回の実行上限を超える要求を拒否する', async () => {
  const { gate, starts } = mockGate([{}, {}], { maxRequests: 1 });
  const first = gate.get(`${origin}/x`);

  await assert.rejects(gate.get(`${origin}/x`), /Concurrent/);

  await first;

  await assert.rejects(gate.get(`${origin}/x`), /Invocation/);
  assert.equal(starts.length, 1);

  const other = mockGate([{}]);

  other.gate.state.day = '2026-11-15';
  other.gate.state.count = 500;

  await assert.rejects(other.gate.get(`${origin}/x`), /daily/);
  assert.equal(other.starts.length, 0);
});

test('429で冷却期限を永続化して停止し、冷却後の要求も計上する', async () => {
  const { gate, starts, advance } = mockGate([
    { status: 429, headers: { 'retry-after': '1200' } },
    { status: 429 },
  ]);

  await assert.rejects(gate.get(`${origin}/x`), /429/);

  const cooldown = gate.state.cooldownUntil;
  const resumed = new HttpGate({
    state: structuredClone(gate.state),
    save: async () => {},
    now: () => cooldown - 1,
    request: async () => assert.fail('冷却中にHTTP要求を送ってはいけない'),
  });

  await assert.rejects(resumed.get(`${origin}/x`), /Cooling/);
  assert.equal(starts.length, 1);

  advance(1200_000);

  await assert.rejects(gate.get(`${origin}/x`), /429/);
  assert.equal(gate.state.rateLimitStops, 2);
  assert.equal(gate.state.count, 2);
});

test('Retry-Afterが秒数・HTTP日時・不正値・過去日時でも最低15分の冷却を確保する', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');

  assert.equal(retryAfter('60', now), now + 900_000);
  assert.equal(retryAfter('1200', now), now + 1200_000);
  assert.equal(
    retryAfter('Sun, 15 Nov 2026 01:00:00 GMT', now),
    now + 3600_000,
  );

  for (const value of ['bad', '', '-1', 'Sat, 14 Nov 2026 00:00:00 GMT'])
    assert.equal(retryAfter(value, now), now + 900_000);
});

test('空の500とタイムアウトを再試行可能にし、連続3失敗で停止する', async () => {
  const { gate } = mockGate([
    { status: 500, body: '' },
    new Error('timeout'),
    { status: 503 },
  ]);

  await assert.rejects(gate.get(`${origin}/x`), (e) => e.retryable);
  await assert.rejects(gate.get(`${origin}/x`), (e) => e.retryable);
  await assert.rejects(gate.get(`${origin}/x`), /Three consecutive/);
  assert.equal(gate.state.count, 3);
});

test('転送もHTTPゲートを通し、別オリジンへの転送と4回目の転送で停止する', async () => {
  const { gate, starts } = mockGate([
    { status: 302, headers: { location: '/next' } },
    {},
  ]);

  await gate.get(`${origin}/x`);

  assert.equal(starts.length, 2);
  assert.equal(starts[1].at - starts[0].at, 12_000);

  const foreign = mockGate([
    { status: 302, headers: { location: 'https://evil.test' } },
  ]);

  await assert.rejects(foreign.gate.get(`${origin}/x`), /Cross-origin/);

  const loop = mockGate(
    Array.from({ length: 4 }, () => ({
      status: 302,
      headers: { location: '/x' },
    })),
  );

  await assert.rejects(loop.gate.get(`${origin}/x`), /Redirect limit/);
  assert.equal(loop.starts.length, 4);
});

test('robotsの拒否・個別許可・エージェントの適用範囲・長い要求間隔を尊重する', async () => {
  const rules = robotsRules(
    'User-agent: *\nDisallow: /search\nAllow: /search/public\nCrawl-delay: 20',
  );

  assert.equal(robotsAllowed(rules, `${origin}/search?k=あ`), false);
  assert.equal(robotsAllowed(rules, `${origin}/search/public`), true);
  assert.equal(rules.delay, 20_000);

  const { gate, starts } = mockGate([{}, {}]);

  gate.state.robots[origin] = { ...rules, checkedAt: gate.now() };

  await assert.rejects(gate.get(`${origin}/search`), /disallows/);
  assert.equal(starts.length, 0);

  await gate.get(`${origin}/x`);
  await gate.get(`${origin}/x`);

  assert.equal(starts[1].at - starts[0].at, 22_000);
  assert.equal(
    robotsAllowed(
      robotsRules(
        'User-agent: *\nDisallow: /\nUser-agent: kanjipedia-link-collector\nAllow: /',
      ),
      `${origin}/x`,
    ),
    true,
  );

  const wild = robotsRules('User-agent: *\nDisallow: /*.php$');

  assert.equal(robotsAllowed(wild, `${origin}/x.php`), false);
  assert.equal(robotsAllowed(wild, `${origin}/x.php/foo`), true);
});

test('robotsの404は未提供と扱い、検索の404は0件として扱わない', async () => {
  const { gate } = mockGate([{ status: 404 }, {}]);

  delete gate.state.robots;

  const policy = await gate.ensureRobots(origin);

  assert.equal(policy.unavailable, true);
  assert.equal((await gate.get(`${origin}/x`)).status, 200);
});

test('HTTPゲートの待機中にCtrl+Cが入ったら次の要求を送らない', async () => {
  let cancelled = false;
  const { gate, starts } = mockGate([{}], {
    cancelled: () => cancelled,
    sleep: async () => {
      cancelled = true;
    },
  });

  await assert.rejects(gate.get(`${origin}/x`), (error) => error.code === 2);
  assert.equal(starts.length, 0);
});

test('robotsのキャッシュは24時間で失効し、明示的な再取得にも対応する', async () => {
  const { gate, starts, advance } = mockGate([
    { body: 'User-agent:*\nDisallow: /private' },
    { body: 'User-agent:*\nDisallow:' },
  ]);

  await gate.ensureRobots(origin);

  assert.equal(starts.length, 0);

  await gate.ensureRobots(origin, { force: true });

  assert.equal(starts.length, 1);

  advance(86_400_001);
  await gate.ensureRobots(origin);

  assert.equal(starts.length, 2);
});

test('robotsの再試行でも次の要求前に同じ待機時間を永続化する', async () => {
  const { gate, starts, saves } = mockGate([
    { status: 500 },
    { status: 503 },
    { body: 'User-agent:*\nDisallow:' },
  ]);

  delete gate.state.robots;
  await gate.ensureRobots(origin);

  assert.equal(starts.length, 3);
  assert.equal(starts[1].at - starts[0].at, 62_000);
  assert.equal(starts[2].at - starts[1].at, 182_000);
  assert.ok(saves.some((state) => state.nextAt === starts[1].at));
  assert.ok(saves.some((state) => state.nextAt === starts[2].at));
  assert.equal(gate.state.count, 3);
  assert.equal(gate.state.consecutiveFailures, 0);
});
