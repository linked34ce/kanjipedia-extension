import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.js';
import { root, validateDictionary } from './dictionary.js';
import { atomicWrite, hash, readJSON, writeJSON } from '../collector/store.js';

// 生の証跡を配布に混入させないよう、対応表と収集範囲の要約だけを出力する。
export async function packageData(
  input,
  {
    directory = path.join(root, 'data/published'),
    extensionOutput = path.join(root, 'extension'),
  } = {},
) {
  const body = await fs.readFile(input, 'utf8');
  const dictionary = await validateDictionary(JSON.parse(body));
  const source = await readJSON(
    path.join(path.dirname(input), 'manifest.json'),
  );

  if (source.sha256 !== hash(body))
    throw new Error('Source manifest hash mismatch');

  const manifest = {
    schemaVersion: dictionary.schemaVersion,
    parserVersion: source.parserVersion,
    runId: source.runId,
    generatedAt: source.generatedAt,
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    complete: source.complete === true,
    prefixes: source.prefixes,
    records: source.records,
    uniqueURLs: source.uniqueURLs,
    unresolved: source.unresolved,
    conflicts: source.conflicts,
    dictionaryKeys: Object.keys(dictionary.entries).length,
    sha256: hash(body),
    source: 'https://www.kanjipedia.jp',
    redistribution: 'github-only-user-approved',
  };

  await atomicWrite(path.join(directory, 'dictionary.json'), body);
  await writeJSON(path.join(directory, 'manifest.json'), manifest);

  return {
    ...(await buildExtension({
      input: path.join(directory, 'dictionary.json'),
      output: extensionOutput,
    })),
    complete: manifest.complete,
    directory,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' } } });

    if (!values.input)
      throw new Error(
        'Usage: node scripts/package-data.js --input DICTIONARY_JSON',
      );

    console.log(JSON.stringify(await packageData(values.input), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
