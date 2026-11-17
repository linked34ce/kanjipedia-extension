import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import {
  headingKey,
  readingKey,
  safePath,
  stableDictionary,
  chooseCandidate,
} from '../shared/core.js';
import { extractSearch, searchPage, searchURL } from '../collector/extract.js';
import { validateDictionary } from '../scripts/build.js';
import { linkDocument, parseSegment, segments } from '../extension/source.js';
import { searchFixture, row } from './fixtures/search.js';
const record = (
  path = '/kotoba/0005614200',
  reading = 'ハクア',
  variant = '白亜',
) => ({ path, reading, variants: [variant] });

test('normalization preserves ideographs, IVS, small kana and punctuation', () => {
  assert.equal(headingKey(' 〈舊神葛󠄀〉 '), '舊神葛󠄀');
  assert.equal(readingKey('(か\u3099く)'), 'ガク');
  assert.notEqual(readingKey('きゃ'), readingKey('きや'));
  assert.notEqual(readingKey('はく・あ'), readingKey('はくあ'));
});

test('segment readings preserve combining kana marks and reject non-kana', () => {
  for (const reading of ['か\u3099く', 'は\u309aく', 'ガク', 'がく']) {
    const parsed = parseSegment({ start: 0, text: `学(${reading})` });
    assert.deepEqual(parsed.readings, [reading]);
  }
  for (const reading of ['学', 'gaku', 'がく!']) {
    assert.equal(parseSegment({ start: 0, text: `学(${reading})` }), null);
  }
});
test('URL allowlist rejects unsafe locations', () => {
  for (const path of [
    'javascript:alert(1)',
    '//evil.test/kotoba/0005614200',
    '/kotoba/123',
    '/kotoba/0005614200?q=x',
    '/kotoba/0005614200#x',
    '/kotoba/000007484700',
    '//evil.test/kotoba/00007484700',
    '/kotoba/00007484700?q=x',
    '/kotoba/00007484700#x',
    'https://user@www.kanjipedia.jp/kotoba/0005614200',
  ])
    assert.equal(safePath(path), null);
  assert.equal(
    safePath('https://www.kanjipedia.jp/kotoba/0005614200'),
    '/kotoba/0005614200',
  );
});
test('verified eleven-digit item IDs survive extraction, schema validation and candidate matching', async () => {
  const path = '/kotoba/00007484700';
  const parsed = extractSearch(
    searchFixture({ rows: row('瞳<sup>▲</sup>睛', 'ドウセイ', '00007484700') }),
    { prefix: 'あ', page: 1 },
  );
  assert.equal(parsed.records[0].path, path);
  assert.equal(safePath(`https://www.kanjipedia.jp${path}`), path);
  const dictionary = stableDictionary(parsed.records);
  await validateDictionary(dictionary);
  assert.equal(chooseCandidate(dictionary, '瞳睛', ['どうせい']), path);
  await assert.rejects(
    validateDictionary({
      schemaVersion: 1,
      entries: {
        瞳睛: [{ path: '/kotoba/000007484700', reading: 'ドウセイ' }],
      },
    }),
  );
});
test('stable dictionary preserves homographs, deduplicates and supports prototype keys', async () => {
  const records = [
    record('/kotoba/0000021500', 'アイジャク', '愛着'),
    record('/kotoba/0000023100', 'アイチャク', '愛着'),
    record(),
    record(),
    record('/kotoba/0000000001', 'ア', '__proto__'),
  ];
  const dictionary = stableDictionary(records);
  assert.equal(dictionary.entries['愛着'].length, 2);
  assert.equal(dictionary.entries['白亜'].length, 1);
  assert.equal(
    JSON.stringify(dictionary),
    JSON.stringify(stableDictionary([...records].reverse())),
  );
  assert.equal(chooseCandidate(dictionary, '__proto__'), '/kotoba/0000000001');
  assert.equal(chooseCandidate(dictionary, 'constructor'), null);
  await validateDictionary(dictionary);
  await assert.rejects(validateDictionary({ schemaVersion: 2, entries: {} }));
  await assert.rejects(
    validateDictionary({
      schemaVersion: 1,
      entries: { a: [{ path: 'https://evil.test', reading: 'ア' }] },
    }),
  );
});
test('reading mismatch and same-reading ambiguity are never guessed', () => {
  const dict = stableDictionary([
    record(),
    record('/kotoba/0000000001', 'ハクア', '曖昧'),
    record('/kotoba/0000000002', 'ハクア', '曖昧'),
  ]);
  assert.equal(chooseCandidate(dict, '白亜', ['はくあ']), '/kotoba/0005614200');
  assert.equal(chooseCandidate(dict, '白亜', ['ハクアキ']), null);
  assert.equal(chooseCandidate(dict, '白亜', ['ハクア', 'ハクアキ']), null);
  assert.equal(chooseCandidate(dict, '曖昧', ['ハクア']), null);
});
test('extract headings/readings only inside result list; preserve raw annotation', () => {
  const html =
    searchFixture({ rows: row('<sup>▲</sup>〈白亜〉') }) +
    '<a href="/kotoba/0000000001">広告</a>';
  const parsed = extractSearch(html, { prefix: 'あ', page: 1 });
  assert.deepEqual(parsed.records[0].variants, ['白亜']);
  assert.equal(parsed.records[0].rawHeading, '▲〈白亜〉');
  assert.equal(parsed.records[0].reading, 'ハクア');
  assert.equal(parsed.records.length, 1);
});
test('middle dots and gaiji remain diagnostics without guessed variants', () => {
  for (const heading of ['白亜・別表記', '<img alt="亜" src="gaiji.png">']) {
    const parsed = extractSearch(searchFixture({ rows: row(heading) }), {
      prefix: 'あ',
      page: 1,
    });
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.diagnostics.length, 1);
  }
});
test('only an exact reviewed path, heading and reading can split variants', () => {
  const verifiedVariants = [
    {
      path: '/kotoba/0005614200',
      rawHeading: '白亜・白▲堊',
      rawReading: '(ハクア)',
      variants: ['白亜', '白堊'],
    },
  ];
  const html = searchFixture({ rows: row('白亜・白<sup>▲</sup>堊') });
  const parsed = extractSearch(html, {
    prefix: 'あ',
    page: 1,
    verifiedVariants,
  });
  assert.deepEqual(parsed.records[0].variants, ['白亜', '白堊']);
  for (const change of [
    { path: '/kotoba/0000000001' },
    { rawReading: '(ア)' },
    { variants: ['白亜', '別字'] },
  ]) {
    const p = extractSearch(html, {
      prefix: 'あ',
      page: 1,
      verifiedVariants: [{ ...verifiedVariants[0], ...change }],
    });
    assert.equal(p.records.length, 0);
  }
});
test('unbracketed kana reading spans on sayings normalize without dropping raw text', () => {
  const parsed = extractSearch(
    searchFixture({
      rows: row('阿吽の呼吸', 'アウンのコキュウ').replace(
        '(アウンのコキュウ)',
        'アウンのコキュウ',
      ),
    }),
    { prefix: 'あ', page: 1 },
  );
  assert.equal(parsed.records[0].reading, 'アウンノコキュウ');
  assert.equal(parsed.records[0].rawReading, 'アウンのコキュウ');
});
test('zero results require valid conditions and count; empty/error DOM fails', () => {
  assert.equal(
    extractSearch(searchFixture({ total: 0, rows: '' }), {
      prefix: 'あ',
      page: 1,
    }).total,
    0,
  );
  for (const html of [
    '',
    '<h1>500</h1>',
    searchFixture({ prefix: 'か' }),
    searchFixture().replace('<br>', ''),
  ])
    assert.throws(() => extractSearch(html, { prefix: 'あ', page: 1 }));
});
test('pager normalizes omitted page and rejects foreign conditions/current page', () => {
  assert.equal(searchPage(searchURL('あ'), 'あ'), 1);
  assert.equal(
    extractSearch(searchFixture({ page: 2, total: 20, last: 14 }), {
      prefix: 'あ',
      page: 2,
    }).lastPage,
    14,
  );
  assert.throws(() =>
    extractSearch(searchFixture({ page: 1 }), { prefix: 'あ', page: 2 }),
  );
  assert.throws(() => searchPage('/search?k=あ&wt=1&sk=leftHand&page=2', 'あ'));
  assert.throws(() => searchPage(searchURL('あ', 0), 'あ'));
});

const fixture = await readFile(
  new URL('./fixtures/kanji.html', import.meta.url),
  'utf8',
);
function domFor(html = fixture, pathname = '/kanji/0000000500') {
  return new JSDOM(html, { url: `https://www.kanjipedia.jp${pathname}` });
}
test('DOM links only exact heading + reading, preserves text, other nodes and events twice', () => {
  const dom = domFor();
  try {
    const doc = dom.window.document;
    const other = doc.getElementById('other');
    let clicks = 0;
    other.addEventListener('click', () => clicks++);
    const before = doc.getElementById('target').textContent,
      otherHTML = other.outerHTML;
    const dictionary = stableDictionary([
      record(),
      record('/kotoba/0000000001', 'ハクアキ', '白亜紀'),
      record('/kotoba/0000000002', 'チガウ', '東亜'),
    ]);
    assert.equal(linkDocument(doc, dictionary), 1);
    assert.equal(doc.querySelector('#target a').textContent, '白亜(ハクア)');
    assert.equal(doc.getElementById('target').textContent, before);
    assert.equal(other.outerHTML, otherHTML);
    other.click();
    assert.equal(clicks, 1);
    assert.equal(linkDocument(doc, dictionary), 0);
    assert.equal(doc.querySelectorAll('a a').length, 0);
  } finally {
    dom.window.close();
  }
});
test('balanced multiple readings; existing links, nested elements, missing section stay safe', () => {
  assert.equal(segments('白亜(ハクア・はくあ)・東亜(トウア)').length, 2);
  assert.deepEqual(segments('白亜(ハクア'), []);
  assert.deepEqual(segments('白亜(ハクア）'), []);
  const dictionary = stableDictionary([record()]);
  for (const [text, expected] of [
    ['白亜(ハクア・はくあ)', 1],
    ['白亜（はくあ）', 1],
    ['  白亜 （はくあ）  ', 1],
    ['白亜(ハクア・チガウ)', 0],
    ['白亜', 1],
    ['<a href="/x">白亜</a>(ハクア)', 0],
    ['<em>白亜</em>(ハクア)', 0],
    ['白亜紀(ハクアキ)', 0],
  ]) {
    const dom = domFor(
      fixture.replace(
        /欧亜\(オウア\)・東亜\(トウア\)・白亜\(ハクア\)・流亜\(リュウア\)/u,
        text,
      ),
    );
    try {
      const doc = dom.window.document;
      assert.equal(linkDocument(doc, dictionary), expected, text);
      if (expected)
        assert.equal(doc.querySelector('#target a').textContent, text.trim());
      if (doc.querySelector('#target a[href]'))
        assert.equal(
          doc.getElementById('target').dataset.kanjipediaShitatsuki,
          '1',
        );
    } finally {
      dom.window.close();
    }
  }
  for (const [html, pathname] of [
    [fixture.replace('alt="下つき"', 'alt="別の欄"'), '/kanji/0000000500'],
    [fixture, '/kotoba/0005614200'],
    [fixture, '/kanji/invalid'],
  ]) {
    const dom = domFor(html, pathname);
    try {
      assert.equal(linkDocument(dom.window.document, dictionary), 0);
    } finally {
      dom.window.close();
    }
  }
});
