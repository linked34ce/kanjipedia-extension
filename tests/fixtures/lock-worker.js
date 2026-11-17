import { acquireLock } from '../../collector/store.js';

process.once('message', async () => {
  let release;

  try {
    release = await acquireLock(process.argv[2]);
  } catch (error) {
    process.send({ type: 'result', acquired: false, error: error.message });
    process.disconnect();

    return;
  }

  process.once('message', async () => {
    await release();
    process.disconnect();
  });
  process.send({ type: 'result', acquired: true, pid: process.pid });
});
process.send({ type: 'ready' });
