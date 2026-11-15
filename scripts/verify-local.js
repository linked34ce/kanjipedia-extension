import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { root, validateDictionary } from './build.js';
import { hash, readJSON, atomicWrite, writeJSON } from '../collector/store.js';
import { ORIGIN, chooseCandidate } from '../shared/core.js';
import { linkDocument } from '../extension/source.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/verify-local.js DICTIONARY_JSON');
const dictionary = await validateDictionary(await readJSON(input));
assert.equal(chooseCandidate(dictionary, '白亜', ['ハクア']), '/kotoba/0005614200');
const survey = path.join(root, '.local/survey');
let evidence;
for (const name of await fs.readdir(survey)) {
  if (!name.endsWith('.json')) continue;
  const row = await readJSON(path.join(survey, name));
  if (row.url === `${ORIGIN}/kanji/0000000500`) evidence = row;
}
assert.ok(evidence, 'Saved 亜 page required; run survey --group article');
const html = await fs.readFile(path.join(survey, evidence.bodyFile), 'utf8');
assert.equal(hash(html), evidence.bodyHash);
const dom = new JSDOM(html, { url: evidence.url });
try {
  const doc = dom.window.document;
  const li = doc.querySelector('img[alt="下つき"]').closest('li');
  const p = li.querySelector(':scope > div > p');
  const before = p.textContent;
  const outside = doc.body.cloneNode(true);
  outside.querySelector('img[alt="下つき"]').closest('li').remove();
  const originalOutside = outside.outerHTML;
  const fragment = li.cloneNode(true);
  fragment.querySelector('p').id = 'target';
  const fragmentHTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>保存した亜の下つき構造</title><ul><li id="other"><p>白亜(ハクア)</p></li>${fragment.outerHTML}</ul></html>`;
  await atomicWrite(path.join(root, '.local/acceptance.html'), fragmentHTML);
  const count = linkDocument(doc, dictionary);
  assert.equal(p.textContent, before);
  const white = [...p.querySelectorAll('a')].find(a => a.textContent === '白亜(ハクア)');
  assert.equal(white?.href, `${ORIGIN}/kotoba/0005614200`);
  assert.equal(linkDocument(doc, dictionary), 0);
  const afterOutside = doc.body.cloneNode(true);
  afterOutside.querySelector('img[alt="下つき"]').closest('li').remove();
  assert.equal(afterOutside.outerHTML, originalOutside);
  const report = { verified: true, count, preservedText: before, sourceURL: evidence.url,
    sourceSHA256: evidence.bodyHash, dictionarySHA256: hash(await fs.readFile(input)),
    sourceKind: 'saved live HTML; no network or external scripts executed', manualLiveCheck: false };
  await writeJSON(path.join(root, 'artifacts/local-acceptance.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally { dom.window.close(); }
