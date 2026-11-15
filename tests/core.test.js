import test from 'node:test';
import assert from 'node:assert/strict';
import { headingKey, readingKey, safePath, stableDictionary, chooseCandidate } from '../shared/core.js';
import { extractSearch, searchPage, searchURL } from '../collector/extract.js';
import { validateDictionary } from '../scripts/build.js';
import { searchFixture, row } from './fixtures/search.js';
const record = (path = '/kotoba/0005614200', reading = 'ハクア', variant = '白亜') => ({ path, reading, variants: [variant] });

test('normalization preserves ideographs, IVS, small kana and punctuation', () => {
  assert.equal(headingKey(' 〈舊神葛󠄀〉 '), '舊神葛󠄀');
  assert.equal(readingKey('(か\u3099く)'), 'ガク');
  assert.notEqual(readingKey('きゃ'), readingKey('きや'));
  assert.notEqual(readingKey('はく・あ'), readingKey('はくあ'));
});
test('URL allowlist rejects unsafe locations', () => {
  for (const path of ['javascript:alert(1)', '//evil.test/kotoba/0005614200', '/kotoba/123',
    '/kotoba/0005614200?q=x', '/kotoba/0005614200#x', 'https://user@www.kanjipedia.jp/kotoba/0005614200']) assert.equal(safePath(path), null);
  assert.equal(safePath('https://www.kanjipedia.jp/kotoba/0005614200'), '/kotoba/0005614200');
});
test('stable dictionary preserves homographs, deduplicates and supports prototype keys', async () => {
  const records = [record('/kotoba/0000021500', 'アイジャク', '愛着'), record('/kotoba/0000023100', 'アイチャク', '愛着'), record(), record(), record('/kotoba/0000000001', 'ア', '__proto__')];
  const dictionary = stableDictionary(records);
  assert.equal(dictionary.entries['愛着'].length, 2);
  assert.equal(dictionary.entries['白亜'].length, 1);
  assert.equal(JSON.stringify(dictionary), JSON.stringify(stableDictionary([...records].reverse())));
  assert.equal(chooseCandidate(dictionary, '__proto__'), '/kotoba/0000000001');
  assert.equal(chooseCandidate(dictionary, 'constructor'), null);
  await validateDictionary(dictionary);
  await assert.rejects(validateDictionary({ schemaVersion: 2, entries: {} }));
  await assert.rejects(validateDictionary({ schemaVersion: 1, entries: { a: [{ path: 'https://evil.test', reading: 'ア' }] } }));
});
test('reading mismatch and same-reading ambiguity are never guessed', () => {
  const dict = stableDictionary([record(), record('/kotoba/0000000001', 'ハクア', '曖昧'), record('/kotoba/0000000002', 'ハクア', '曖昧')]);
  assert.equal(chooseCandidate(dict, '白亜', ['はくあ']), '/kotoba/0005614200');
  assert.equal(chooseCandidate(dict, '白亜', ['ハクアキ']), null);
  assert.equal(chooseCandidate(dict, '白亜', ['ハクア', 'ハクアキ']), null);
  assert.equal(chooseCandidate(dict, '曖昧', ['ハクア']), null);
});
test('extract headings/readings only inside result list; preserve raw annotation', () => {
  const html = searchFixture({ rows: row('<sup>▲</sup>〈白亜〉') }) + '<a href="/kotoba/0000000001">広告</a>';
  const parsed = extractSearch(html, { prefix: 'あ', page: 1 });
  assert.deepEqual(parsed.records[0].variants, ['白亜']);
  assert.equal(parsed.records[0].rawHeading, '▲〈白亜〉');
  assert.equal(parsed.records[0].reading, 'ハクア');
  assert.equal(parsed.records.length, 1);
});
test('middle dots and gaiji remain diagnostics without guessed variants', () => {
  for (const heading of ['白亜・別表記', '<img alt="亜" src="gaiji.png">']) {
    const parsed = extractSearch(searchFixture({ rows: row(heading) }), { prefix: 'あ', page: 1 });
    assert.equal(parsed.records.length, 0); assert.equal(parsed.diagnostics.length, 1);
  }
});
test('only an exact reviewed path, heading and reading can split variants', () => {
  const verifiedVariants = [{ path: '/kotoba/0005614200', rawHeading: '白亜・白▲堊',
    rawReading: '(ハクア)', variants: ['白亜', '白堊'] }];
  const html = searchFixture({ rows: row('白亜・白<sup>▲</sup>堊') });
  const parsed = extractSearch(html, { prefix: 'あ', page: 1, verifiedVariants });
  assert.deepEqual(parsed.records[0].variants, ['白亜', '白堊']);
  for (const change of [{ path: '/kotoba/0000000001' }, { rawReading: '(ア)' }, { variants: ['白亜', '別字'] }]) {
    const p = extractSearch(html, { prefix: 'あ', page: 1, verifiedVariants: [{ ...verifiedVariants[0], ...change }] });
    assert.equal(p.records.length, 0);
  }
});
test('unbracketed kana reading spans on sayings normalize without dropping raw text', () => {
  const parsed = extractSearch(searchFixture({ rows: row('阿吽の呼吸', 'アウンのコキュウ').replace('(アウンのコキュウ)', 'アウンのコキュウ') }), { prefix: 'あ', page: 1 });
  assert.equal(parsed.records[0].reading, 'アウンノコキュウ');
  assert.equal(parsed.records[0].rawReading, 'アウンのコキュウ');
});
test('zero results require valid conditions and count; empty/error DOM fails', () => {
  assert.equal(extractSearch(searchFixture({ total: 0, rows: '' }), { prefix: 'あ', page: 1 }).total, 0);
  for (const html of ['', '<h1>500</h1>', searchFixture({ prefix: 'か' }), searchFixture().replace('<br>', '')])
    assert.throws(() => extractSearch(html, { prefix: 'あ', page: 1 }));
});
test('pager normalizes omitted page and rejects foreign conditions/current page', () => {
  assert.equal(searchPage(searchURL('あ'), 'あ'), 1);
  assert.equal(extractSearch(searchFixture({ page: 2, total: 20, last: 14 }), { prefix: 'あ', page: 2 }).lastPage, 14);
  assert.throws(() => extractSearch(searchFixture({ page: 1 }), { prefix: 'あ', page: 2 }));
  assert.throws(() => searchPage('/search?k=あ&wt=1&sk=leftHand&page=2', 'あ'));
  assert.throws(() => searchPage(searchURL('あ', 0), 'あ'));
});
