import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { atomicWrite, hash, readJSON } from '../collector/store.js';
import { root, validateDictionary } from './dictionary.js';

export { root, validateDictionary } from './dictionary.js';

export async function buildExtension({
  input = path.join(root, 'data/published/dictionary.json'),
  output = path.join(root, 'extension'),
} = {}) {
  const body = await fs.readFile(input, 'utf8');
  const dictionary = await validateDictionary(JSON.parse(body));
  const manifest = await readJSON(
    path.join(path.dirname(input), 'manifest.json'),
    null,
  );

  if (manifest && manifest.sha256 !== hash(body))
    throw new Error('Dictionary manifest hash mismatch');

  await fs.mkdir(output, { recursive: true });

  if (path.resolve(output) !== path.resolve(root, 'extension')) {
    for (const file of ['manifest.json', 'content.css'])
      await fs.copyFile(
        path.join(root, 'extension', file),
        path.join(output, file),
      );
  }

  const serialized = JSON.stringify(JSON.stringify(dictionary))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  await atomicWrite(
    path.join(output, 'data.js'),
    `globalThis.__KANJIPEDIA_DATA__ = JSON.parse(${serialized});\n`,
  );
  await build({
    entryPoints: [path.join(root, 'extension/source.js')],
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    outfile: path.join(output, 'content.js'),
  });

  return {
    bytes: Buffer.byteLength(body),
    sha256: hash(body),
    keys: Object.keys(dictionary.entries).length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await buildExtension(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
