import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpGate,
  robotsRules,
  robotsAllowed,
  retryAfter,
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
      starts.push({ at: clock, url, options });
      clock += 2000;
      const next = responses.shift();
      if (next instanceof Error) throw next;
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
test('all request starts serialize after response + 10 seconds and persist budgets', async () => {
  const { gate, starts, saves } = mockGate([{}, {}]);
  await gate.get(`${origin}/search`);
  await gate.get(`${origin}/robots.txt`, { robots: false });
  assert.equal(starts[1].at - starts[0].at, 12_000);
  assert.equal(gate.state.count, 2);
  assert.ok(saves[0].nextAt >= saves[0].lastAt + 40_000);
  assert.ok(starts[0].options.signal instanceof AbortSignal);
  assert.equal(starts[0].options.redirect, 'manual');
});
test('reject concurrency and daily/invocation limits', async () => {
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
test('429 stops with persistent cooldown and counts subsequent attempts', async () => {
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
  });
  await assert.rejects(resumed.get(`${origin}/x`), /Cooling/);
  assert.equal(starts.length, 1);
  advance(1200_000);
  await assert.rejects(gate.get(`${origin}/x`), /429/);
  assert.equal(gate.state.rateLimitStops, 2);
  assert.equal(gate.state.count, 2);
});
test('Retry-After seconds, HTTP date, invalid and past date choose at least 15 minutes', () => {
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
test('401/403/404, empty 200 and block pages stop; empty 500 is retryable, never zero', async () => {
  for (const item of [
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { body: '' },
    { body: '<h1>CAPTCHA</h1>' },
  ]) {
    const { gate } = mockGate([item]);
    await assert.rejects(gate.get(`${origin}/x`));
  }
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
test('redirects use gate; foreign host and fourth redirect stop', async () => {
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
test('robots deny paths, allow specific paths, respect agent groups and longer delays', async () => {
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
test('robots 404 is unavailable; search 404 is never a zero-result page', async () => {
  const { gate } = mockGate([{ status: 404 }, {}]);
  delete gate.state.robots;
  const policy = await gate.ensureRobots(origin);
  assert.equal(policy.unavailable, true);
  assert.equal((await gate.get(`${origin}/x`)).status, 200);
});
test('Ctrl+C during gate wait prevents another request', async () => {
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
test('robots cache expires after 24 hours and supports an explicit refresh', async () => {
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
