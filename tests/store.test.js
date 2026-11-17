import { temporaryDirectory } from './helpers/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import {
  acquireLock,
  readJSON,
  writeJSON,
  atomicWrite,
} from '../collector/store.js';

for (const stage of ['writeFile', 'sync', 'rename']) {
  test(`原子的保存の${stage}で失敗しても直前の確定ファイルを保持する`, async (t) => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, 'state.json');
    const before = '{"世代":"確定済み"}\n';
    const failure = Object.assign(new Error('保存先のI/O障害'), {
      code: 'EIO',
    });

    await fs.writeFile(file, before);

    let fault;

    if (stage === 'rename') {
      fault = t.mock.method(fs, 'rename', async () => {
        throw failure;
      });
    } else {
      const open = fs.open.bind(fs);

      fault = t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);

        t.mock.method(handle, stage, async () => {
          throw failure;
        });

        return handle;
      });
    }

    await assert.rejects(atomicWrite(file, '{"世代":"更新中"}\n'), failure);
    assert.equal(await fs.readFile(file, 'utf8'), before);

    fault.mock.restore();
    await writeJSON(file, { 世代: '次の確定' });

    assert.deepEqual(await readJSON(file), { 世代: '次の確定' });
  });
}

test('JSONの既定値はファイル欠落時だけ返し、破損JSONを隠さない', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'state.json');

  assert.deepEqual(await readJSON(file, { empty: true }), { empty: true });
  await fs.writeFile(file, '{');

  await assert.rejects(readJSON(file, { empty: true }), SyntaxError);
});

const deadPid = spawnSync(process.execPath, ['-e', '']).pid;

assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

test('古いロックの回復で並行して取得されたロックを削除しない', async (t) => {
  const directory = await temporaryDirectory(t),
    file = path.join(directory, 'collector.lock');

  await fs.writeFile(file, JSON.stringify({ pid: deadPid, token: 'stale' }));

  const readFile = fs.readFile.bind(fs);
  const observed = Promise.withResolvers(),
    resume = Promise.withResolvers();
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

  try {
    second = await Promise.allSettled([acquireLock(directory)]);
  } finally {
    resume.resolve();
  }

  const results = [...(await Promise.allSettled([first])), ...second];

  read.mock.restore();

  const winners = results.filter((result) => result.status === 'fulfilled');

  try {
    assert.equal(winners.length, 1, 'ロックを保持できる収集プロセスは1つだけ');
    assert.equal((await readJSON(file)).pid, process.pid);
  } finally {
    await Promise.allSettled(winners.map((winner) => winner.value()));
  }

  const release = await acquireLock(directory);

  await release();
});

test(
  '4プロセスが古いロックの回復を競合しても所有者は1つだけになる',
  { timeout: 15_000 },
  async (t) => {
    const directory = await temporaryDirectory(t),
      file = path.join(directory, 'collector.lock');

    await fs.writeFile(file, JSON.stringify({ pid: deadPid, token: 'stale' }));

    const workers = Array.from({ length: 4 }, () => {
      const child = fork(
        new URL('./fixtures/lock-worker.js', import.meta.url),
        [directory],
        {
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        },
      );

      t.after(() => {
        if (child.exitCode === null) child.kill();
      });

      const ready = Promise.withResolvers(),
        result = Promise.withResolvers();

      child.on('message', (message) => {
        if (message.type === 'ready') ready.resolve();

        if (message.type === 'result') result.resolve(message);
      });
      child.on('error', (error) => {
        ready.reject(error);
        result.reject(error);
      });

      const exited = new Promise((resolve) =>
        child.on('exit', (code) => {
          ready.reject(new Error('ロック検証用プロセスが準備完了前に終了した'));
          result.reject(
            new Error('ロック検証用プロセスが結果を報告する前に終了した'),
          );
          resolve(code);
        }),
      );

      return { child, ready: ready.promise, result: result.promise, exited };
    });

    await Promise.all(workers.map((worker) => worker.ready));

    for (const worker of workers) worker.child.send('acquire');

    const results = await Promise.all(workers.map((worker) => worker.result));
    const winners = results.filter((result) => result.acquired);

    assert.equal(winners.length, 1);
    assert.equal((await readJSON(file)).pid, winners[0].pid);

    for (const result of results.filter((result) => !result.acquired))
      assert.match(result.error, /already running|lock maintenance is busy/);

    workers[results.findIndex((result) => result.acquired)].child.send(
      'release',
    );

    assert.deepEqual(
      await Promise.all(workers.map((worker) => worker.exited)),
      [0, 0, 0, 0],
    );

    const release = await acquireLock(directory);

    await release();
  },
);

test('残存した更新ガードを検出したら古いロックを変更せず安全側に停止する', async (t) => {
  const directory = await temporaryDirectory(t),
    file = path.join(directory, 'collector.lock');
  const stale = JSON.stringify({ pid: deadPid, token: 'stale' });

  await fs.writeFile(file, stale);
  await fs.mkdir(path.join(directory, 'collector.lock.guard'));

  await assert.rejects(acquireLock(directory), /collector\.lock\.guard/);
  assert.equal(await fs.readFile(file, 'utf8'), stale);

  // 手動で復旧する前に、すべての収集プロセスが停止していることを確認する。
  await fs.rmdir(path.join(directory, 'collector.lock.guard'));

  const release = await acquireLock(directory);

  await release();
});

test('破損したロックでは安全側に停止して更新ガードを解放する', async (t) => {
  const directory = await temporaryDirectory(t),
    file = path.join(directory, 'collector.lock');

  await fs.writeFile(file, '{');

  await assert.rejects(acquireLock(directory), SyntaxError);
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  await assert.rejects(fs.stat(path.join(directory, 'collector.lock.guard')), {
    code: 'ENOENT',
  });
});

test('解放を繰り返しても次の所有者のロックを削除しない', async (t) => {
  const directory = await temporaryDirectory(t),
    file = path.join(directory, 'collector.lock');
  const release = await acquireLock(directory);

  await release();
  await release();

  const nextRelease = await acquireLock(directory),
    owner = await readJSON(file);

  await release();

  assert.deepEqual(await readJSON(file), owner);

  await nextRelease();
});
