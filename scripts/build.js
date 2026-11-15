import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import Ajv from 'ajv';
import { atomicWrite, hash, readJSON } from '../collector/store.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function validateDictionary(dictionary) {
  const schema = JSON.parse(await fs.readFile(path.join(root, 'data/dictionary.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true, ownProperties: true }).compile(schema);
  if (!validate(dictionary)) throw new Error(`Dictionary schema: ${JSON.stringify(validate.errors)}`);
  return dictionary;
}
export async function buildExtension({ input = path.join(root, 'data/dictionary.json'), output = path.join(root, 'extension') } = {}) {
  const body = await fs.readFile(input, 'utf8');
  const dictionary = await validateDictionary(JSON.parse(body));
  const manifest = await readJSON(path.join(path.dirname(input), 'manifest.json'), null);
  if (manifest && manifest.sha256 !== hash(body)) throw new Error('Dictionary manifest hash mismatch');
  await fs.mkdir(output, { recursive: true });
  if (path.resolve(output) !== path.resolve(root, 'extension'))
    await fs.copyFile(path.join(root, 'extension/manifest.json'), path.join(output, 'manifest.json'));
  const serialized = JSON.stringify(JSON.stringify(dictionary)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await atomicWrite(path.join(output, 'data.js'), `globalThis.__KANJIPEDIA_DATA__ = JSON.parse(${serialized});\n`);
  await build({ entryPoints: [path.join(root, 'extension/source.js')], bundle: true, format: 'iife', target: 'chrome120', outfile: path.join(output, 'content.js') });
  return { bytes: Buffer.byteLength(body), sha256: hash(body), keys: Object.keys(dictionary.entries).length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildExtension(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
