import { temporaryDirectory } from './helpers/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildExtension } from '../scripts/build.js';
import { hash, writeJSON } from '../collector/store.js';

test('生成JSで特殊文字列とプロトタイプ名のキーを安全に復元し、MV3を最小権限で読み込む', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = path.join(directory, 'dictionary.json');
  const dictionary = {
    schemaVersion: 1,
    entries: Object.fromEntries([
      ['__proto__', [{ path: '/kotoba/0000000001', reading: 'ア' }]],
      [
        '</script>\u2028\u2029',
        [{ path: '/kotoba/0000000002', reading: 'イ' }],
      ],
    ]),
  };

  await writeJSON(input, dictionary);

  const bodyHash = hash(await fs.readFile(input));

  await writeJSON(path.join(directory, 'manifest.json'), { sha256: bodyHash });

  const output = path.join(directory, 'extension');
  const result = await buildExtension({ input, output });

  assert.equal(result.sha256, bodyHash);

  const script = await fs.readFile(path.join(output, 'data.js'), 'utf8');

  assert.ok(!script.includes('</script>'));

  const context = vm.createContext({});

  vm.runInContext(script, context);

  assert.equal(
    JSON.stringify(context.__KANJIPEDIA_DATA__),
    JSON.stringify(dictionary),
  );

  const manifest = JSON.parse(
    await fs.readFile(path.join(output, 'manifest.json'), 'utf8'),
  );

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].js, ['data.js', 'content.js']);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.background, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://www.kanjipedia.jp/kanji/*',
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
});

test('入力manifestのハッシュ不一致でビルドを拒否し、既存生成物を保持する', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = path.join(directory, 'dictionary.json');
  const output = path.join(directory, 'extension');
  await writeJSON(input, { schemaVersion: 1, entries: {} });
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'data.js'), '確定済みの生成物');

  await writeJSON(path.join(directory, 'manifest.json'), { sha256: 'wrong' });

  await assert.rejects(buildExtension({ input, output }), /hash mismatch/);
  assert.deepEqual(await fs.readdir(output), ['data.js']);
  assert.equal(
    await fs.readFile(path.join(output, 'data.js'), 'utf8'),
    '確定済みの生成物',
  );
});
