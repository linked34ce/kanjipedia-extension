import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { acquireLock, readJSON } from '../collector/store.js';

const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

async function lockDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kanjipedia-lock-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('stale lock recovery cannot delete a concurrently acquired lock', async t => {
  const directory = await lockDirectory(t), file = path.join(directory, 'collector.lock');
  await fs.writeFile(file, JSON.stringify({ pid: deadPid, token: 'stale' }));
  const readFile = fs.readFile.bind(fs);
  const observed = Promise.withResolvers(), resume = Promise.withResolvers();
  let paused = false;
  const read = t.mock.method(fs, 'readFile', async (...args) => {
    const value = await readFile(...args);
    if (args[0] === file && !paused) {
      paused = true;
      observed.resolve();
      await resume.promise;
    }
    return value;
  });
  const first = acquireLock(directory);
  await observed.promise;
  let second;
  try { second = await Promise.allSettled([acquireLock(directory)]); }
  finally { resume.resolve(); }
  const results = [...await Promise.allSettled([first]), ...second];
  read.mock.restore();
  const winners = results.filter(result => result.status === 'fulfilled');
  try {
    assert.equal(winners.length, 1, 'only one collector may hold the lock');
    assert.equal((await readJSON(file)).pid, process.pid);
  } finally {
    await Promise.allSettled(winners.map(winner => winner.value()));
  }
  const release = await acquireLock(directory);
  await release();
});

test('four processes competing for a stale lock have exactly one owner', { timeout: 15_000 }, async t => {
  const directory = await lockDirectory(t), file = path.join(directory, 'collector.lock');
  await fs.writeFile(file, JSON.stringify({ pid: deadPid, token: 'stale' }));
  const workers = Array.from({ length: 4 }, () => {
    const child = fork(new URL('./fixtures/lock-worker.js', import.meta.url), [directory], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const ready = Promise.withResolvers(), result = Promise.withResolvers();
    child.on('message', message => {
      if (message.type === 'ready') ready.resolve();
      if (message.type === 'result') result.resolve(message);
    });
    child.on('error', error => { ready.reject(error); result.reject(error); });
    const exited = new Promise(resolve => child.on('exit', code => {
      ready.reject(new Error('Lock worker exited before becoming ready'));
      result.reject(new Error('Lock worker exited before reporting its result'));
      resolve(code);
    }));
    return { child, ready: ready.promise, result: result.promise, exited };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send('acquire');
  const results = await Promise.all(workers.map(worker => worker.result));
  const winners = results.filter(result => result.acquired);
  assert.equal(winners.length, 1);
  assert.equal((await readJSON(file)).pid, winners[0].pid);
  for (const result of results.filter(result => !result.acquired))
    assert.match(result.error, /already running|lock maintenance is busy/);
  workers[results.findIndex(result => result.acquired)].child.send('release');
  assert.deepEqual(await Promise.all(workers.map(worker => worker.exited)), [0, 0, 0, 0]);
  const release = await acquireLock(directory);
  await release();
});

test('an abandoned mutation guard fails closed without changing the stale lock', async t => {
  const directory = await lockDirectory(t), file = path.join(directory, 'collector.lock');
  const stale = JSON.stringify({ pid: deadPid, token: 'stale' });
  await fs.writeFile(file, stale);
  await fs.mkdir(path.join(directory, 'collector.lock.guard'));
  await assert.rejects(acquireLock(directory), /collector\.lock\.guard/);
  assert.equal(await fs.readFile(file, 'utf8'), stale);
  // Manual recovery is allowed only once all collectors have stopped.
  await fs.rmdir(path.join(directory, 'collector.lock.guard'));
  const release = await acquireLock(directory);
  await release();
});

test('malformed lock fails closed and releases the mutation guard', async t => {
  const directory = await lockDirectory(t), file = path.join(directory, 'collector.lock');
  await fs.writeFile(file, '{');
  await assert.rejects(acquireLock(directory), SyntaxError);
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  await assert.rejects(fs.stat(path.join(directory, 'collector.lock.guard')), { code: 'ENOENT' });
});

test('repeated release cannot remove a subsequent owner lock', async t => {
  const directory = await lockDirectory(t), file = path.join(directory, 'collector.lock');
  const release = await acquireLock(directory);
  await release();
  await release();
  const nextRelease = await acquireLock(directory), owner = await readJSON(file);
  await release();
  assert.deepEqual(await readJSON(file), owner);
  await nextRelease();
});
