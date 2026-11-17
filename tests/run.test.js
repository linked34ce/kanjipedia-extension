import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'kanjipedia-test-'));
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
      return new Response(bodies.shift() ?? '', {
        status: bodies.status ?? 200,
      });
    },
  });
  return { gate, calls: () => calls };
}
test('persistent queue finishes last remainder page and resumes without HTTP', async () => {
  const directory = await temporary();
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
test('inflight recovery after evidence save, parse or done-write interruption never refetches', async () => {
  for (const stage of ['after-fetch', 'after-parse', 'before-done']) {
    const directory = await temporary();
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
    if (stage !== 'after-fetch')
      job.parsed = extractSearch(html, { prefix: 'あ', page: 1 });
    await writeJSON(path.join(directory, 'run.json'), run);
    const resumed = await readJSON(path.join(directory, 'run.json'));
    assert.equal((await processRun(resumed, directory, null)).complete, true);
    assert.equal(resumed.queue[0].state, 'done');
  }
});
test('atomic response envelope reconstructs HTML after interrupted HTML write', async () => {
  const directory = await temporary(),
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

test('invalid recovery envelope fails without recreating HTML or fetching', async () => {
  const directory = await temporary();
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

test('offline reparse leaves pages without saved evidence pending', async () => {
  const directory = await temporary();
  const run = createRun(plan);
  const report = await processRun(run, directory, null, { reparse: true });
  assert.equal(report.complete, false);
  assert.deepEqual(report.prefixes[0].missingPages, [1]);
  const saved = await readJSON(path.join(directory, 'run.json'));
  assert.equal(saved.queue[0].state, 'pending');
  assert.equal(saved.queue[0].attempts, 0);
});
test('corrupt saved HTML fails closed; orphan temporary write does not replace valid state', async () => {
  const directory = await temporary(),
    file = path.join(directory, 'state.json');
  await writeJSON(file, { valid: true });
  await fs.writeFile(`${file}.interrupted.tmp`, '{');
  assert.deepEqual(await readJSON(file), { valid: true });
  await atomicWrite(path.join(directory, '3042-1.html'), searchFixture());
  await writeJSON(path.join(directory, '3042-1.response.json'), {
    bodyHash: 'wrong',
  });
  const run = createRun(plan);
  await assert.rejects(processRun(run, directory, null), /hash mismatch/);
  assert.equal(run.complete, false);
});
test('pagination infers unseen pages beyond visible pager window; rejects total drift and duplicate body', () => {
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
test('missing pages and count mismatch cannot be complete', () => {
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
test('incomplete export cannot overwrite a complete published generation', async () => {
  const directory = await temporary(),
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
test('process lock rejects a second collector; release permits next collector', async () => {
  const directory = await temporary();
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /already running/);
  await release();
  const nextRelease = await acquireLock(directory);
  await nextRelease();
});
test('retry counters survive failures and cap at three; all HTTP attempts count', async () => {
  const directory = await temporary(),
    run = createRun(plan);
  const bodies = ['fail', 'fail', 'fail'];
  bodies.status = 500;
  const { gate, calls } = fakeGate(bodies);
  await assert.rejects(processRun(run, directory, gate), /Three consecutive/);
  assert.equal(calls(), 3);
  assert.equal(gate.state.count, 4); // robots + failures
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
