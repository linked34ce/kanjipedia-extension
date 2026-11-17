import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewVariants } from '../collector/review.js';
import { writeJSON, atomicWrite, hash } from '../collector/store.js';
import { searchFixture, row } from './fixtures/search.js';
test('variant review requires matching saved search and individual article evidence', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kanjipedia-review-'),
  );
  const bodies = [
    searchFixture({ rows: row('白亜・白<sup>▲</sup>堊') }),
    '<div id="kotobaArea"><p>白亜・白<sup>▲</sup>堊</p><p class="kotobaYomi">ハクア</p></div>',
  ];
  for (let i = 0; i < bodies.length; i++) {
    await atomicWrite(path.join(directory, `${i}.html`), bodies[i]);
    await writeJSON(path.join(directory, `${i}.json`), {
      status: 200,
      url: i
        ? 'https://www.kanjipedia.jp/kotoba/0005614200'
        : 'https://www.kanjipedia.jp/search?k=あ&wy=1&sk=leftHand',
      bodyFile: `${i}.html`,
      bodyHash: hash(bodies[i]),
      fetchedAt: '2026-11-15T00:00:00Z',
    });
  }
  const review = await reviewVariants(directory, '/kotoba/0005614200', [
    '白亜',
    '白堊',
  ]);
  assert.equal(review.evidence.length, 2);
  await assert.rejects(
    reviewVariants(directory, '/kotoba/0005614200', ['白亜', '別字']),
    /do not agree/,
  );
  await assert.rejects(
    reviewVariants(directory, 'https://evil.test', ['白亜', '白堊']),
    /Invalid/,
  );
  await fs.writeFile(path.join(directory, '1.html'), 'tampered');
  await assert.rejects(
    reviewVariants(directory, '/kotoba/0005614200', ['白亜', '白堊']),
    /hash mismatch/,
  );
});
