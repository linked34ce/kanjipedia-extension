import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kanjipedia-test-'),
  );

  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(os.tmpdir()),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  return directory;
}
