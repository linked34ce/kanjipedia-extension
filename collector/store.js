import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');

  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(temporary, file);
}

export const writeJSON = (file, value) =>
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);

export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;

    throw error;
  }
}

async function withLockGuard(directory, action) {
  const guard = path.join(directory, 'collector.lock.guard');

  // 古いロックの回復とトークン照合後の解放も含め、すべてのロック更新を直列化する。
  // 同じ競合が再発するため、このガード自体は自動回収しない。
  try {
    await fs.mkdir(guard);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Collector lock maintenance is busy (collector.lock.guard); see docs/development.md',
        { cause: error },
      );

    throw error;
  }

  try {
    return await action();
  } finally {
    await fs.rmdir(guard);
  }
}

export async function acquireLock(directory) {
  await fs.mkdir(directory, { recursive: true });

  const file = path.join(directory, 'collector.lock');
  const token = randomUUID();

  return withLockGuard(directory, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(file, 'wx');

        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        } finally {
          await handle.close();
        }

        return () =>
          withLockGuard(directory, async () => {
            const existing = await readJSON(file, null);

            if (existing?.token === token) await fs.unlink(file);
          });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;

        const existing = await readJSON(file); // ロックが破損していたら安全側に停止する

        try {
          process.kill(existing.pid, 0);
        } catch (probe) {
          if (probe.code === 'ESRCH') {
            await fs.unlink(file);

            continue;
          }
        }

        throw new Error('Collector is already running (collector.lock)', {
          cause: error,
        });
      }
    }

    throw new Error('Could not acquire collector lock');
  });
}
