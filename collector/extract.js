import { JSDOM } from 'jsdom';
import { ORIGIN, PARSER_VERSION, safePath, headingKey, readingKey } from '../shared/core.js';

export function searchURL(prefix, page = 1, explicitFirst = false) {
  const url = new URL('/search', ORIGIN);
  url.search = new URLSearchParams({ k: prefix, wy: '1', sk: 'leftHand' });
  if (page !== 1 || explicitFirst) url.searchParams.set('page', String(page));
  return url.href;
}
export function searchPage(url, prefix) {
  const u = new URL(url, ORIGIN);
  if (u.origin !== ORIGIN || u.pathname !== '/search' || u.searchParams.get('k') !== prefix ||
      u.searchParams.get('wy') !== '1' || u.searchParams.get('sk') !== 'leftHand' ||
      [...u.searchParams.keys()].some(k => !['k', 'wy', 'sk', 'page'].includes(k)))
    throw new Error('Unexpected pager conditions');
  const page = Number(u.searchParams.get('page') ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid page');
  return page;
}

export function extractAnchor(anchor, verifiedVariants = []) {
  const path = safePath(anchor.getAttribute('href'));
  if (!path) throw new Error('Unsafe item URL');
  const nodes = [...anchor.childNodes];
  const br = nodes.findIndex(n => n.nodeType === 1 && n.tagName === 'BR');
  if (br < 0) throw new Error('Missing heading/reading separator');
  const head = anchor.ownerDocument.createElement('div');
  nodes.slice(0, br).forEach(n => head.append(n.cloneNode(true)));
  const rawHeading = head.textContent.trim();
  if (head.querySelector('img')) return { diagnostic: 'uninterpreted-image', path, rawHeading };
  if ([...head.querySelectorAll('*')].some(n => n.tagName !== 'SUP' || !/^[▲△]+$/.test(n.textContent)))
    return { diagnostic: 'uninterpreted-heading-markup', path, rawHeading };
  head.querySelectorAll('sup').forEach(n => n.remove());
  const readingNodes = nodes.slice(br + 1).filter(n => n.nodeType !== 3 || n.textContent.trim());
  if (readingNodes.length !== 1 || readingNodes[0].nodeName !== 'SPAN' ||
      readingNodes[0].children.length) throw new Error('Unexpected reading structure');
  const rawReading = readingNodes[0].textContent.trim();
  if (!rawReading || (/[()（）]/u.test(rawReading) && !/^(\([^()]+\)|（[^（）]+）)$/.test(rawReading)))
    return { diagnostic: 'uninterpreted-reading', path, rawHeading, rawReading };
  const reading = readingKey(rawReading);
  if (!/^[ァ-ヺー・･]+$/u.test(reading))
    return { diagnostic: 'uninterpreted-reading', path, rawHeading, rawReading };
  const heading = headingKey(head.textContent);
  // A middle dot can be a literal character. Until a verified structural rule exists,
  // keep the row as evidence, but do not expose guessed variants to the extension.
  const verified = verifiedVariants.find(item => item.path === path && item.rawHeading === rawHeading &&
    item.rawReading === rawReading && item.variants?.length > 1 &&
    item.variants.every(v => typeof v === 'string' && v && !v.includes('・')) && item.variants.join('・') === heading);
  if (heading.includes('・') && !verified)
    return { diagnostic: 'unresolved-middle-dot', path, rawHeading, rawReading };
  if (!heading) throw new Error('Empty heading');
  return { path, rawHeading, rawReading, variants: verified?.variants ?? [heading], reading };
}

export function extractSearch(html, { prefix, page, verifiedVariants = [], ...source }) {
  if (!html.trim()) throw new Error('Empty response is not a zero-result page');
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    const condition = [...document.querySelectorAll('#resultCondition > li')]
      .map(n => n.textContent.replace(/\s+/gu, ''));
    if (JSON.stringify(condition) !== JSON.stringify([
      `検索ワード：${prefix}`, '絞り込み：「言葉のよみ」', '検索条件：「～で始まる」'
    ])) throw new Error(`Search conditions mismatch: ${JSON.stringify(condition)}`);
    const countText = document.querySelector('#resultCount')?.textContent.replace(/\s+/gu, '');
    const match = /^言葉[：:]([\d,]+)件$/.exec(countText ?? '');
    if (!match) throw new Error(`Missing result count: ${countText}`);
    const total = Number(match[1].replaceAll(',', ''));
    const lists = document.querySelectorAll('#resultKotobaList');
    if (lists.length > 1 || (total > 0 && lists.length !== 1)) throw new Error('Missing result list');
    const anchors = [...(lists[0]?.querySelectorAll(':scope > li > a') ?? [])];
    if ((lists[0]?.children.length ?? 0) !== anchors.length) throw new Error('Unexpected result row');
    if (total === 0) {
      if (anchors.length || page !== 1) throw new Error('Invalid zero-result page');
      return { total, page, lastPage: 1, rowCount: 0, records: [], diagnostics: [], parserVersion: PARSER_VERSION };
    }
    if (!anchors.length || anchors.length > total) throw new Error('Result count mismatch');
    const currents = [...document.querySelectorAll('.pagerSection .pageOn.current')];
    const singlePageWithoutPager = !currents.length && page === 1 && anchors.length === total &&
      !document.querySelector('.pagerSection a[href]');
    if ((!currents.length && !singlePageWithoutPager) || currents.some(n => Number(n.textContent.trim()) !== page))
      throw new Error('Current page mismatch');
    let lastPage = page;
    for (const a of document.querySelectorAll('.pagerSection a[href]'))
      lastPage = Math.max(lastPage, searchPage(a.getAttribute('href'), prefix));
    if (page > lastPage || (page === 1 && lastPage === 1 && anchors.length !== total))
      throw new Error('Pager does not account for total');
    const records = [], diagnostics = [];
    for (const a of anchors) {
      const result = extractAnchor(a, verifiedVariants);
      if (result.diagnostic) diagnostics.push(result);
      else records.push({ ...result, source: { ...source, prefix, page } });
    }
    if (new Set(anchors.map(a => safePath(a.getAttribute('href')))).size !== anchors.length)
      throw new Error('Duplicate item URL within page');
    return { total, page, lastPage, rowCount: anchors.length, records, diagnostics, parserVersion: PARSER_VERSION };
  } finally { dom.window.close(); }
}
