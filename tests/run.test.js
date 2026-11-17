import { temporaryDirectory } from './helpers/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createRun,
  processRun,
  acceptPage,
  reportRun,
  exportRun,
} from '../collector/run.js';
import {
  readJSON,
  writeJSON,
  atomicWrite,
  acquireLock,
  hash,
} from '../collector/store.js';
import { HttpGate } from '../collector/http.js';
import { extractSearch } from '../collector/extract.js';
import { searchFixture, row } from './fixtures/search.js';

const plan = [{ prefix: 'あ', status: 'target', verification: 'unconfirmed' }];

function fakeGate(bodies) {
  let now = Date.parse('2026-11-15T00:00:00Z'),
    calls = 0;
  const gate = new HttpGate({
    state: {},
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
    save: async () => {},
    request: async (url) => {
      if (url.endsWith('/robots.txt'))
        return new Response('User-agent:*\nDisallow:');

      calls++;
      assert.ok(bodies.length, `予定外の検索要求: ${url}`);

      const body = bodies.shift();

      if (body instanceof Response) return body;

      return new Response(body ?? '', {
        status: bodies.status ?? 200,
      });
    },
  });

  return { gate, calls: () => calls };
}

test('永続キューで端数の最終ページまで完了し、再開時はHTTPで再取得しない', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(plan);
  const { gate, calls } = fakeGate([
    searchFixture({
      total: 3,
      last: 2,
      rows: row() + row('東亜', 'トウア', '0000000001'),
    }),
    searchFixture({
      page: 2,
      total: 3,
      last: 2,
      rows: row('欧亜', 'オウア', '0000000002'),
    }),
  ]);
  const report = await processRun(run, directory, gate);

  assert.equal(report.complete, true);
  assert.equal(report.prefixes[0].rows, 3);
  assert.equal(calls(), 2);

  const saved = await readJSON(path.join(directory, 'run.json'));

  await processRun(saved, directory, gate);

  assert.equal(calls(), 2);

  const before = JSON.stringify(saved.queue.map((j) => j.parsed));

  await processRun(saved, directory, null, { reparse: true });

  assert.equal(JSON.stringify(saved.queue.map((j) => j.parsed)), before);
});

for (const [label, parsed] of [
  ['解析結果のない取得済みページ', undefined],
  ['古い解析結果が残る取得済みページ', { records: [{ variants: ['誤解析'] }] }],
]) {
  test(`${label}を保存HTMLから再解析し、HTTPで再取得せず復元する`, async (t) => {
    const directory = await temporaryDirectory(t);
    const run = createRun(plan),
      job = run.queue[0];
    const html = searchFixture();

    await atomicWrite(path.join(directory, '3042-1.html'), html);
    await writeJSON(path.join(directory, '3042-1.response.json'), {
      bodyHash: hash(html),
      fetchedAt: '2026-11-15T00:00:00Z',
      status: 200,
      url: 'https://www.kanjipedia.jp/search?k=あ&wy=1&sk=leftHand',
    });
    job.state = 'inflight';

    job.parsed = parsed;

    await writeJSON(path.join(directory, 'run.json'), run);

    const resumed = await readJSON(path.join(directory, 'run.json'));

    assert.equal((await processRun(resumed, directory, null)).complete, true);
    assert.equal(resumed.queue[0].state, 'done');
    assert.deepEqual(resumed.queue[0].parsed.records[0].variants, ['白亜']);
  });
}

test('HTML書き込みが中断しても原子的に保存した応答一式からHTMLを復元する', async (t) => {
  const directory = await temporaryDirectory(t),
    run = createRun(plan),
    html = searchFixture();

  await writeJSON(path.join(directory, '3042-1.response.json'), {
    body: html,
    bodyHash: hash(html),
    status: 200,
    fetchedAt: '2026-11-15T00:00:00Z',
    url: 'https://www.kanjipedia.jp/search?k=あ&wy=1&sk=leftHand',
  });

  assert.equal((await processRun(run, directory, null)).complete, true);
  assert.equal(
    await fs.readFile(path.join(directory, '3042-1.html'), 'utf8'),
    html,
  );
});

for (const boundary of ['HTML保存', '完了状態保存']) {
  for (const failures of [0, 2]) {
    test(`${failures + 1}回目の取得後の${boundary}に失敗しても保存済み応答から再取得せず再開する`, async (t) => {
      const directory = await temporaryDirectory(t);
      const run = createRun(plan);
      const html = searchFixture();
      const { gate, calls } = fakeGate([
        ...Array.from(
          { length: failures },
          () => new Response('fail', { status: 503 }),
        ),
        html,
      ]);
      const rename = fs.rename.bind(fs);
      const failure = Object.assign(new Error('保存境界でのI/O障害'), {
        code: 'EIO',
      });
      let injected = false;

      t.mock.method(fs, 'rename', async (from, to) => {
        const target =
          boundary === 'HTML保存'
            ? to.endsWith('.html')
            : to.endsWith('run.json') &&
              JSON.parse(await fs.readFile(from, 'utf8')).queue[0].state ===
                'done';

        if (target && !injected) {
          injected = true;
          throw failure;
        }

        return rename(from, to);
      });

      await assert.rejects(processRun(run, directory, gate), failure);
      assert.equal(injected, true, '指定した保存境界まで処理を進める');

      const saved = await readJSON(path.join(directory, 'run.json'));
      assert.equal(saved.queue[0].state, 'failed');
      assert.equal(saved.queue[0].attempts, failures + 1);
      assert.equal(saved.queue[0].httpAttempts, failures + 1);
      assert.deepEqual(
        gate.state.events
          .filter((event) => !event.url.endsWith('/robots.txt'))
          .map((event) => event.status),
        [...Array(failures).fill(503), 200],
      );
      const evidence = await readJSON(
        path.join(directory, '3042-1.response.json'),
      );

      assert.equal(evidence.status, 200);
      assert.equal(evidence.body, html);
      assert.equal(evidence.bodyHash, hash(html));
      let resumed;

      await assert.doesNotReject(async () => {
        resumed = await processRun(saved, directory, null);
      }, '保存済みの応答だけで再開でき、HTTPゲートを必要としない');

      assert.equal(calls(), failures + 1, '保存失敗後も応答を再取得しない');
      assert.equal(resumed.complete, true);
      assert.equal(
        await fs.readFile(path.join(directory, '3042-1.html'), 'utf8'),
        html,
      );
      const completed = await readJSON(path.join(directory, 'run.json'));

      assert.equal(completed.queue[0].state, 'done');
      assert.equal(completed.queue[0].attempts, failures + 1);
      assert.deepEqual(completed.queue[0].parsed.records[0].variants, ['白亜']);
    });
  }
}

for (const state of ['failed', 'pending', 'inflight']) {
  test(`保存応答がなく試行上限に達した${state}ページはHTTP要求前に停止する`, async (t) => {
    const directory = await temporaryDirectory(t);
    const run = createRun(plan);

    Object.assign(run.queue[0], { state, attempts: 3 });
    await writeJSON(path.join(directory, 'run.json'), run);

    const saved = await readJSON(path.join(directory, 'run.json'));

    await assert.rejects(processRun(saved, directory, null), {
      code: 3,
      message: 'Exhausted page; investigate before a new run',
    });
    assert.equal(saved.complete, false);
    assert.equal(saved.queue[0].attempts, 3);
  });
}

test('復元用の応答一式が不正ならHTMLの復元や再取得をせず停止する', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(plan);

  await writeJSON(path.join(directory, '3042-1.response.json'), {
    body: searchFixture(),
    bodyHash: 'wrong',
  });

  await assert.rejects(
    processRun(run, directory, null),
    /Saved envelope hash mismatch/,
  );
  await assert.rejects(fs.access(path.join(directory, '3042-1.html')), {
    code: 'ENOENT',
  });

  const saved = await readJSON(path.join(directory, 'run.json'));

  assert.equal(saved.queue[0].state, 'failed');
  assert.equal(saved.queue[0].attempts, 0);
  assert.equal(saved.complete, false);
});

test('オフライン再解析では保存証跡のないページを未処理のまま残す', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(plan);
  const report = await processRun(run, directory, null, { reparse: true });

  assert.equal(report.complete, false);
  assert.deepEqual(report.prefixes[0].missingPages, [1]);

  const saved = await readJSON(path.join(directory, 'run.json'));

  assert.equal(saved.queue[0].state, 'pending');
  assert.equal(saved.queue[0].attempts, 0);
});

test('保存HTMLのハッシュが不一致なら安全側に停止する', async (t) => {
  const directory = await temporaryDirectory(t);

  await atomicWrite(path.join(directory, '3042-1.html'), searchFixture());
  await writeJSON(path.join(directory, '3042-1.response.json'), {
    bodyHash: 'wrong',
  });

  const run = createRun(plan);

  await assert.rejects(processRun(run, directory, null), /hash mismatch/);
  assert.equal(run.complete, false);
});

test('表示範囲外のページも推定し、総件数の変動と本文の重複を拒否する', () => {
  const run = createRun(plan),
    job = run.queue[0];

  job.bodyHash = 'one';
  acceptPage(run, job, {
    total: 30,
    page: 1,
    lastPage: 10,
    rowCount: 2,
    records: [],
    diagnostics: [],
  });

  assert.equal(run.queue.length, 15);

  const second = run.queue[1];

  second.bodyHash = 'one';

  assert.throws(
    () =>
      acceptPage(run, second, {
        total: 30,
        page: 2,
        lastPage: 15,
        rowCount: 2,
      }),
    /Repeated/,
  );

  second.bodyHash = 'two';

  assert.throws(
    () =>
      acceptPage(run, second, {
        total: 31,
        page: 2,
        lastPage: 15,
        rowCount: 2,
      }),
    /total changed/,
  );
});

test('欠落ページや件数の不一致があれば収集完了にしない', () => {
  const run = createRun(plan),
    job = run.queue[0];

  job.bodyHash = 'one';
  acceptPage(run, job, {
    total: 2,
    page: 1,
    lastPage: 2,
    rowCount: 1,
    records: [{ path: '/kotoba/0005614200' }],
    diagnostics: [],
  });

  assert.deepEqual(reportRun(run).prefixes[0].missingPages, [2]);

  const last = run.queue[1];

  last.bodyHash = 'two';

  assert.throws(
    () =>
      acceptPage(run, last, {
        total: 2,
        page: 2,
        lastPage: 2,
        rowCount: 1,
        records: [{ path: '/kotoba/0005614200' }],
        diagnostics: [],
      }),
    /unique URLs/,
  );
});

test('未完了の出力では完成した世代の参照を上書きしない', async (t) => {
  const directory = await temporaryDirectory(t),
    run = createRun(plan);
  const { gate } = fakeGate([searchFixture()]);

  await processRun(run, path.join(directory, 'run'), gate);

  const exported = await exportRun(run, path.join(directory, 'data'));
  const pointer = await readJSON(path.join(directory, 'data/current.json'));
  const incomplete = createRun(plan);

  await assert.rejects(
    exportRun(incomplete, path.join(directory, 'data')),
    /Incomplete/,
  );

  const partial = await exportRun(incomplete, path.join(directory, 'data'), {
    partial: true,
  });

  assert.equal(partial.complete, false);
  assert.deepEqual(
    await readJSON(path.join(directory, 'data/current.json')),
    pointer,
  );
  assert.equal(
    exported.sha256,
    hash(await fs.readFile(path.join(exported.directory, 'dictionary.json'))),
  );
});

test('プロセスロックで二重収集を拒否し、解放後は次の収集を許可する', async (t) => {
  const directory = await temporaryDirectory(t);
  const release = await acquireLock(directory);

  await assert.rejects(acquireLock(directory), /already running/);

  await release();

  const nextRelease = await acquireLock(directory);

  await nextRelease();
});

test('失敗後も試行回数を保持して3回で打ち切り、すべてのHTTP要求を計上する', async (t) => {
  const directory = await temporaryDirectory(t),
    run = createRun(plan);
  const bodies = ['fail', 'fail', 'fail'];

  bodies.status = 500;

  const { gate, calls } = fakeGate(bodies);

  await assert.rejects(processRun(run, directory, gate), /Three consecutive/);
  assert.equal(calls(), 3);
  assert.equal(gate.state.count, 4); // robots取得と失敗した要求の合計
  assert.equal(run.queue[0].attempts, 3);
  assert.equal(run.queue[0].httpAttempts, 3);

  const events = gate.state.events.filter(
    (event) => !event.url.endsWith('/robots.txt'),
  );

  assert.equal(
    Date.parse(events[1].fetchedAt) - Date.parse(events[0].fetchedAt),
    60_000,
  );
  assert.equal(
    Date.parse(events[2].fetchedAt) - Date.parse(events[1].fetchedAt),
    180_000,
  );
  await assert.rejects(processRun(run, directory, gate), /Exhausted page/);
  assert.equal(calls(), 3);
});

test('同一URLの見出し・読みの矛盾で後続取得を止め、再開・再解析・部分出力でも矛盾を保持する', async (t) => {
  for (const [heading, reading] of [
    ['白堊', 'ハクア'],
    ['白亜', 'ア'],
  ]) {
    const directory = await temporaryDirectory(t);
    const run = createRun(['あ', 'か', 'さ'].map((prefix) => ({ prefix })));
    const { gate, calls } = fakeGate([
      searchFixture(),
      searchFixture({ prefix: 'か', rows: row(heading, reading) }),
      searchFixture({ prefix: 'さ' }),
    ]);
    const stopped = (error) => {
      assert.equal(error.code, 3);
      assert.match(error.message, /Conflicting item data.*0005614200/);

      return true;
    };

    await assert.rejects(processRun(run, directory, gate), stopped);
    assert.equal(calls(), 2, '矛盾が確定した後は次の検索ページを取得しない');

    const saved = await readJSON(path.join(directory, 'run.json'));

    assert.equal(saved.complete, false);
    assert.deepEqual(
      saved.queue.map((job) => job.state),
      ['done', 'failed', 'pending'],
    );
    assert.match(saved.queue[1].error, /Conflicting item data/);
    assert.equal(saved.queue[1].parsed.records[0].reading, reading);
    assert.deepEqual(reportRun(saved).conflicts, ['/kotoba/0005614200']);

    await assert.rejects(processRun(saved, directory, gate), stopped);
    await assert.rejects(
      processRun(saved, directory, null, { reparse: true }),
      stopped,
    );
    assert.equal(calls(), 2, '再開やオフライン再解析でも追加取得しない');

    await assert.rejects(exportRun(saved, path.join(directory, 'data')), {
      code: 2,
    });

    const partial = await exportRun(saved, path.join(directory, 'data'), {
      partial: true,
    });
    const dictionary = await readJSON(
      path.join(partial.directory, 'dictionary.json'),
    );

    assert.equal(partial.complete, false);
    assert.deepEqual(partial.conflicts, ['/kotoba/0005614200']);
    assert.deepEqual(
      dictionary.entries,
      {},
      '先に取得した候補も含めて除外する',
    );
  }
});

test('同じ接頭辞の途中ページで矛盾した場合も末尾ページの取得前に停止する', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(plan);
  const { gate, calls } = fakeGate([
    searchFixture({ total: 3, last: 3 }),
    searchFixture({ page: 2, total: 3, last: 3, rows: row('白堊') }),
    searchFixture({ page: 3, total: 3, last: 3 }),
  ]);

  await assert.rejects(processRun(run, directory, gate), {
    code: 3,
    message: 'Conflicting item data: /kotoba/0005614200',
  });
  assert.equal(calls(), 2);
  assert.deepEqual(
    reportRun(await readJSON(path.join(directory, 'run.json'))).conflicts,
    ['/kotoba/0005614200'],
  );
});

test('旧実装で保存した矛盾のあるrunも再開時に取得前に停止する', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(['あ', 'か', 'さ'].map((prefix) => ({ prefix })));

  for (const [index, heading] of ['白亜', '白堊'].entries()) {
    const job = run.queue[index];

    job.state = 'done';
    job.parsed = extractSearch(
      searchFixture({ prefix: job.prefix, rows: row(heading) }),
      { prefix: job.prefix, page: 1 },
    );
  }

  const { gate, calls } = fakeGate([searchFixture({ prefix: 'さ' })]);

  await assert.rejects(processRun(run, directory, gate), {
    code: 3,
  });
  assert.equal(calls(), 0);
  assert.equal(gate.used, 0, 'robotsを含むHTTP要求を一切送らない');
  assert.deepEqual(
    reportRun(await readJSON(path.join(directory, 'run.json'))).conflicts,
    ['/kotoba/0005614200'],
  );
});

test('別の接頭辞に現れる同一URLでも見出しと読みが一致すれば収集を続ける', async (t) => {
  const directory = await temporaryDirectory(t);
  const run = createRun(['あ', 'か', 'さ'].map((prefix) => ({ prefix })));
  const { gate, calls } = fakeGate(
    ['あ', 'か', 'さ'].map((prefix) => searchFixture({ prefix })),
  );
  const report = await processRun(run, directory, gate);

  assert.equal(calls(), 3);
  assert.equal(report.complete, true);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.uniqueURLs, 1);
});
