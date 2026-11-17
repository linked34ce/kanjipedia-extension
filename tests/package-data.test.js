import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packageData } from '../scripts/package-data.js';
import { hash, readJSON, writeJSON } from '../collector/store.js';

test('GitHub package preserves mapping and partial coverage without leaking raw evidence', async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kanjipedia-package-'),
  );
  const input = path.join(temporary, 'dictionary.json');
  await writeJSON(input, {
    schemaVersion: 1,
    entries: {
      白亜: [{ path: '/kotoba/0005614200', reading: 'ハクア' }],
    },
  });
  const manifest = {
    parserVersion: '1.0.0',
    runId: 'test-run',
    complete: false,
    prefixes: [{ prefix: 'はくあ', missingPages: [2] }],
    records: 1,
    uniqueURLs: 1,
    unresolved: 1,
    conflicts: [],
    sha256: hash(await fs.readFile(input)),
    body: '<html>private raw evidence</html>',
    bodyFile: 'C:/private/file.html',
    headers: { cookie: 'private-cookie' },
  };
  await writeJSON(path.join(temporary, 'manifest.json'), manifest);
  const directory = path.join(temporary, 'published'),
    extensionOutput = path.join(temporary, 'extension');
  const result = await packageData(input, { directory, extensionOutput });
  const published = await readJSON(path.join(directory, 'manifest.json'));
  assert.equal(result.complete, false);
  assert.equal(result.sha256, manifest.sha256);
  assert.deepEqual(
    await fs.readFile(path.join(directory, 'dictionary.json')),
    await fs.readFile(input),
  );
  assert.deepEqual(published.prefixes, manifest.prefixes);
  assert.equal(published.redistribution, 'github-only-user-approved');
  assert.ok(!JSON.stringify(published).includes('private'));
  assert.ok(await fs.stat(path.join(extensionOutput, 'data.js')));
  await writeJSON(path.join(temporary, 'manifest.json'), {
    ...manifest,
    sha256: 'wrong',
  });
  await assert.rejects(
    packageData(input, { directory, extensionOutput }),
    /hash mismatch/,
  );
});
