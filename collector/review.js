import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { hash, readJSON } from './store.js';
import { extractAnchor } from './extract.js';
import { safePath, headingKey, readingKey, ORIGIN } from '../shared/core.js';

// レビューは指定行の完全一致に限り、他のパスや見出しの扱いは推測しない。
export async function reviewVariants(directory, itemPath, variants) {
  if (
    !safePath(itemPath) ||
    !/^\/kotoba\/\d{10,11}$/.test(itemPath) ||
    variants.length < 2 ||
    variants.some((v) => !v || /[・<>\s]/u.test(v))
  )
    throw new Error('Invalid reviewed variants');

  let search, article;

  for (const file of await fs.readdir(directory)) {
    if (!file.endsWith('.json')) continue;

    const evidence = await readJSON(path.join(directory, file));

    if (evidence.status !== 200) continue;

    const url = new URL(evidence.url);

    if (url.pathname !== '/search' && evidence.url !== `${ORIGIN}${itemPath}`)
      continue;

    const html = await fs.readFile(
      path.join(directory, evidence.bodyFile),
      'utf8',
    );

    if (hash(html) !== evidence.bodyHash)
      throw new Error('Evidence hash mismatch');

    const dom = new JSDOM(html);

    try {
      if (url.pathname === '/search') {
        for (const a of dom.window.document.querySelectorAll(
          '#resultKotobaList > li > a',
        )) {
          if (safePath(a.getAttribute('href')) !== itemPath) continue;

          const result = extractAnchor(a);

          if (result.diagnostic !== 'unresolved-middle-dot')
            throw new Error('Row does not need a middle-dot review');

          search = { ...result, evidence };
        }
      } else {
        const heading = dom.window.document.querySelector(
          '#kotobaArea > p:not(.kotobaYomi)',
        );
        const yomi = dom.window.document.querySelector(
          '#kotobaArea > p.kotobaYomi',
        );

        if (!heading || !yomi || heading.querySelector('img'))
          throw new Error('Unrecognized article heading');

        for (const sup of heading.querySelectorAll('sup')) {
          if (!/^[▲△]+$/u.test(sup.textContent))
            throw new Error('Unknown annotation');

          sup.remove();
        }

        if (heading.children.length) throw new Error('Unknown article markup');

        article = {
          heading: headingKey(heading.textContent),
          reading: readingKey(yomi.textContent),
          evidence,
        };
      }
    } finally {
      dom.window.close();
    }
  }

  if (
    !search ||
    !article ||
    variants.join('・') !== article.heading ||
    article.reading !== readingKey(search.rawReading) ||
    headingKey(search.rawHeading.replace(/[▲△]/gu, '')) !== article.heading
  )
    throw new Error('Search, article and proposed variants do not agree');

  return {
    path: itemPath,
    rawHeading: search.rawHeading,
    rawReading: search.rawReading,
    variants,
    reviewedAt: new Date().toISOString(),
    evidence: [search.evidence, article.evidence].map((e) => ({
      url: e.url,
      bodyHash: e.bodyHash,
      fetchedAt: e.fetchedAt,
    })),
  };
}
