import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { root } from '../scripts/dictionary.js';
import { hash, writeJSON } from '../collector/store.js';

const execute = promisify(execFile);
const validate = (input) =>
  execute(
    process.execPath,
    ['collector/cli.js', 'validate', '--input', input],
    {
      cwd: root,
    },
  );

async function dictionaryFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kanjipedia-cli-'));
  const input = path.join(directory, 'dictionary.json');

  await writeJSON(input, {
    schemaVersion: 1,
    entries: { 白亜: [{ path: '/kotoba/0005614200', reading: 'ハクア' }] },
  });

  return { directory, input };
}

test('validateはmanifestと一致する辞書を受け入れ、構造が正しくても内容が変われば拒否する', async () => {
  const { directory, input } = await dictionaryFile();

  await writeJSON(path.join(directory, 'manifest.json'), {
    sha256: hash(await fs.readFile(input)),
  });

  assert.deepEqual(JSON.parse((await validate(input)).stdout), { valid: true });

  const dictionary = JSON.parse(await fs.readFile(input, 'utf8'));

  dictionary.entries.白亜[0].reading = 'ア';
  await writeJSON(input, dictionary);

  await assert.rejects(validate(input), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Dictionary manifest hash mismatch/);

    return true;
  });
});

test('validateはmanifestのない合成辞書を検証でき、生成物を書き込まない', async () => {
  const { directory, input } = await dictionaryFile();

  assert.deepEqual(JSON.parse((await validate(input)).stdout), { valid: true });
  assert.deepEqual(await fs.readdir(directory), ['dictionary.json']);
});

test('validateは破損したmanifestを未提供として扱わず拒否する', async () => {
  const { directory, input } = await dictionaryFile();

  await fs.writeFile(path.join(directory, 'manifest.json'), '{');
  await assert.rejects(validate(input), (error) => error.code === 1);
});
