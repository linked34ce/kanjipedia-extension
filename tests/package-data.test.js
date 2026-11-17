import { temporaryDirectory } from './helpers/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { packageData } from '../scripts/package-data.js';
import { hash, readJSON, writeJSON } from '../collector/store.js';

async function packageInput(t) {
  const temporary = await temporaryDirectory(t);
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

  return { temporary, input, manifest };
}

test('GitHub向けパッケージは対応表と収集範囲だけを公開し、生の証跡を含めない', async (t) => {
  const { temporary, input, manifest } = await packageInput(t);

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
  assert.deepEqual(published, {
    schemaVersion: 1,
    parserVersion: '1.0.0',
    runId: 'test-run',
    complete: false,
    prefixes: [{ prefix: 'はくあ', missingPages: [2] }],
    records: 1,
    uniqueURLs: 1,
    unresolved: 1,
    conflicts: [],
    dictionaryKeys: 1,
    sha256: manifest.sha256,
    source: 'https://www.kanjipedia.jp',
    redistribution: 'github-only-user-approved',
  });
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    'dictionary.json',
    'manifest.json',
  ]);
  assert.deepEqual((await fs.readdir(extensionOutput)).sort(), [
    'content.css',
    'content.js',
    'data.js',
    'manifest.json',
  ]);
});

test('入力ハッシュが不一致なら公開済み辞書・manifest・生成JSを上書きしない', async (t) => {
  const { temporary, input, manifest } = await packageInput(t);
  const directory = path.join(temporary, 'published');
  const extensionOutput = path.join(temporary, 'extension');

  await packageData(input, { directory, extensionOutput });
  const files = [
    path.join(directory, 'dictionary.json'),
    path.join(directory, 'manifest.json'),
    path.join(extensionOutput, 'data.js'),
  ];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));

  await writeJSON(path.join(temporary, 'manifest.json'), {
    ...manifest,
    sha256: 'wrong',
  });

  await assert.rejects(
    packageData(input, { directory, extensionOutput }),
    /hash mismatch/,
  );
  assert.deepEqual(
    await Promise.all(files.map((file) => fs.readFile(file))),
    before,
  );
});
