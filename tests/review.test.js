import { temporaryDirectory } from './helpers/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { reviewVariants } from '../collector/review.js';
import { writeJSON, atomicWrite, hash } from '../collector/store.js';
import { searchFixture, row } from './fixtures/search.js';

async function evidenceFor(t, { article, omit, status = 200 } = {}) {
  const directory = await temporaryDirectory(t);
  const bodies = [
    searchFixture({ rows: row('白亜・白<sup>▲</sup>堊') }),
    article ??
      '<div id="kotobaArea"><p>白亜・白<sup>▲</sup>堊</p><p class="kotobaYomi">ハクア</p></div>',
  ];

  for (let i = 0; i < bodies.length; i++) {
    if (i === omit) continue;

    await atomicWrite(path.join(directory, String(i) + '.html'), bodies[i]);
    await writeJSON(path.join(directory, String(i) + '.json'), {
      status,
      url: i
        ? 'https://www.kanjipedia.jp/kotoba/0005614200'
        : 'https://www.kanjipedia.jp/search?k=あ&wy=1&sk=leftHand',
      bodyFile: String(i) + '.html',
      bodyHash: hash(bodies[i]),
      fetchedAt: '2026-11-15T00:00:00Z',
    });
  }

  return directory;
}

const itemPath = '/kotoba/0005614200';
const variants = ['白亜', '白堊'];

test('検索と記事の表記・読み・ハッシュが一致した異表記だけを承認する', async (t) => {
  const directory = await evidenceFor(t);
  const review = await reviewVariants(directory, itemPath, variants);

  assert.partialDeepStrictEqual(review, {
    path: itemPath,
    rawHeading: '白亜・白▲堊',
    rawReading: '(ハクア)',
    variants,
  });
  assert.deepEqual(
    review.evidence.map((item) => item.url),
    [
      'https://www.kanjipedia.jp/search?k=あ&wy=1&sk=leftHand',
      'https://www.kanjipedia.jp/kotoba/0005614200',
    ],
  );
});

for (const [label, options] of [
  ['検索証跡がない', { omit: 0 }],
  ['記事証跡がない', { omit: 1 }],
  ['成功応答の証跡がない', { status: 500 }],
  [
    '記事の読みが違う',
    {
      article:
        '<div id="kotobaArea"><p>白亜・白堊</p><p class="kotobaYomi">ア</p></div>',
    },
  ],
  [
    '記事の表記が違う',
    {
      article:
        '<div id="kotobaArea"><p>白亜・別字</p><p class="kotobaYomi">ハクア</p></div>',
    },
  ],
]) {
  test('異表記レビューで' + label + '場合は承認しない', async (t) => {
    const directory = await evidenceFor(t, options);

    await assert.rejects(
      reviewVariants(directory, itemPath, variants),
      /do not agree/,
    );
  });
}

test('提案した異表記が証跡と違えば承認しない', async (t) => {
  const directory = await evidenceFor(t);

  await assert.rejects(
    reviewVariants(directory, itemPath, ['白亜', '別字']),
    /do not agree/,
  );
});

test('外部URLを異表記レビューの対象にしない', async (t) => {
  const directory = await evidenceFor(t);

  await assert.rejects(
    reviewVariants(directory, 'https://evil.test', variants),
    /Invalid reviewed variants/,
  );
});

for (const index of [0, 1]) {
  test(
    '異表記レビューで' +
      (index === 0 ? '検索' : '記事') +
      '本文の改変を検出する',
    async (t) => {
      const directory = await evidenceFor(t);
      await fs.writeFile(
        path.join(directory, String(index) + '.html'),
        '改変された本文',
      );

      await assert.rejects(
        reviewVariants(directory, itemPath, variants),
        /Evidence hash mismatch/,
      );
    },
  );
}
