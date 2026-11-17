import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { buildExtension } from '../scripts/build.js';
import { hash, writeJSON } from '../collector/store.js';

test('build validates generation hash and safely round-trips JS-sensitive and prototype keys', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kanjipedia-build-'),
  );
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
  await writeJSON(path.join(directory, 'manifest.json'), { sha256: 'wrong' });
  await assert.rejects(buildExtension({ input, output }), /hash mismatch/);
});
