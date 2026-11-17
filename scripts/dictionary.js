import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

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
