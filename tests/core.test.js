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
import { validateDictionary } from '../scripts/dictionary.js';
import { linkDocument, parseSegment, segments } from '../extension/source.js';
import { searchFixture, row } from './fixtures/search.js';

const record = (
  path = '/kotoba/0005614200',
  reading = 'ハクア',
  variant = '白亜',
) => ({ path, reading, variants: [variant] });

test('正規化しても漢字・IVS・小書き仮名・句読点を保持する', () => {
  assert.equal(headingKey(' 〈舊神葛󠄀〉 '), '舊神葛󠄀');
  assert.equal(readingKey('(か\u3099く)'), 'ガク');
  assert.notEqual(readingKey('きゃ'), readingKey('きや'));
  assert.notEqual(readingKey('はく・あ'), readingKey('はくあ'));
});

test('区切った読みの結合濁点・半濁点を保持し、仮名以外は拒否する', () => {
  for (const reading of ['か\u3099く', 'は\u309aく', 'ガク', 'がく']) {
    const parsed = parseSegment({ start: 0, text: `学(${reading})` });

    assert.deepEqual(parsed.readings, [reading]);
  }

  for (const reading of ['学', 'gaku', 'がく!']) {
    assert.equal(parseSegment({ start: 0, text: `学(${reading})` }), null);
  }
});

test('URLの許可条件に合わない危険な参照先を拒否する', () => {
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

test('確認済みの11桁の項目IDを抽出・スキーマ検証・候補照合で保持する', async () => {
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

test('安定した辞書生成で同形異読を保持し、重複を除去してプロトタイプ名のキーも扱う', async () => {
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

test('読みが不一致または同じ読みの候補が曖昧な場合はリンク先を推測しない', () => {
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

test('検索結果一覧からだけ見出しと読みを抽出し、元の注記を保持する', () => {
  const html =
    searchFixture({ rows: row('<sup>▲</sup>〈白亜〉') }) +
    '<a href="/kotoba/0000000001">広告</a>';
  const parsed = extractSearch(html, { prefix: 'あ', page: 1 });

  assert.deepEqual(parsed.records[0].variants, ['白亜']);
  assert.equal(parsed.records[0].rawHeading, '▲〈白亜〉');
  assert.equal(parsed.records[0].reading, 'ハクア');
  assert.equal(parsed.records.length, 1);
});

test('中点と外字を含む行は異表記を推測せず解析保留にする', () => {
  for (const heading of ['白亜・別表記', '<img alt="亜" src="gaiji.png">']) {
    const parsed = extractSearch(searchFixture({ rows: row(heading) }), {
      prefix: 'あ',
      page: 1,
    });

    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.diagnostics.length, 1);
  }
});

test('レビュー済みのパス・見出し・読みが完全一致する場合だけ異表記を分割する', () => {
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

test('ことわざの括弧なしの仮名読みを正規化し、原文も保持する', () => {
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

test('検索条件と件数が正しい場合だけ0件と判定し、空のDOMやエラー画面は拒否する', () => {
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

test('ページ番号の省略を正規化し、異なる検索条件や現在ページの不一致を拒否する', () => {
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

test('見出しと読みが完全一致する場合だけリンクし、再実行しても原文・他のノード・イベントを保持する', () => {
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

test('括弧内の複数読みを扱い、既存リンク・入れ子要素・対象欄の欠落を安全に扱う', () => {
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

test('未確認の対象欄構造では文書全体を変更しない', () => {
  const dictionary = stableDictionary([record()]);

  for (const change of [
    (doc) => doc.querySelector('h4 img').remove(),
    (doc) =>
      doc.body.append(doc.querySelector('img[alt="下つき"]').cloneNode()),
    (doc) => {
      const heading = doc.querySelector('img[alt="下つき"]').parentElement;

      heading.replaceWith(...heading.childNodes);
    },
    (doc) =>
      doc.getElementById('target').parentElement.append(doc.createElement('p')),
    (doc) =>
      doc
        .getElementById('target')
        .closest('li')
        .append(doc.createElement('div')),
    (doc) => doc.getElementById('target').append(doc.createElement('em')),
  ]) {
    const dom = domFor();

    try {
      const doc = dom.window.document;

      change(doc);

      const before = doc.documentElement.outerHTML;

      assert.equal(linkDocument(doc, dictionary), 0);
      assert.equal(doc.documentElement.outerHTML, before);
    } finally {
      dom.window.close();
    }
  }
});

test('複数のリンク挿入でも既存ノードを保持し、別々のテキストノードをまたがない', () => {
  const dom = domFor();

  try {
    const doc = dom.window.document;
    const p = doc.getElementById('target');
    const dictionary = stableDictionary([
      record(),
      record('/kotoba/0000000001', 'トウア', '東亜'),
    ]);

    p.innerHTML =
      ' 白亜(ハクア) ・東亜(トウア)・<a href="/existing">白亜</a>(ハクア)';

    const existing = p.querySelector('a');
    const text = p.textContent;

    assert.equal(linkDocument(doc, dictionary), 2);
    assert.deepEqual(
      [...p.querySelectorAll('a[data-kanjipedia-link]')].map(
        (a) => a.textContent,
      ),
      ['白亜(ハクア)', '東亜(トウア)'],
    );
    assert.equal(p.textContent, text);
    assert.equal(p.querySelector('a[href="/existing"]'), existing);
    assert.equal(linkDocument(doc, dictionary), 0);

    p.replaceChildren(
      doc.createTextNode('白亜'),
      doc.createTextNode('(ハクア)'),
    );

    assert.equal(linkDocument(doc, dictionary), 0);
    assert.equal(p.childNodes.length, 2);
  } finally {
    dom.window.close();
  }
});
