import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { hash, readJSON } from '../collector/store.js';

export const root = fileURLToPath(new URL('../', import.meta.url));

export async function validateDictionary(dictionary) {
  const schema = JSON.parse(
    await fs.readFile(path.join(root, 'data/dictionary.schema.json'), 'utf8'),
  );
  const validate = new Ajv({ allErrors: true, ownProperties: true }).compile(
    schema,
  );

  if (!validate(dictionary))
    throw new Error(`Dictionary schema: ${JSON.stringify(validate.errors)}`);

  return dictionary;
}

export async function loadDictionary(input) {
  const body = await fs.readFile(input, 'utf8');
  const dictionary = await validateDictionary(JSON.parse(body));
  const manifest = await readJSON(
    path.join(path.dirname(input), 'manifest.json'),
    null,
  );

  if (manifest && manifest.sha256 !== hash(body))
    throw new Error('Dictionary manifest hash mismatch');

  return { body, dictionary };
}
