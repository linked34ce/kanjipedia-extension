import { chooseCandidate, ORIGIN } from '../shared/core.js';

// Balanced brackets prevent dots inside readings from splitting words.
export function segments(text) {
  const parts = [];
  let start = 0;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if ('(（'.includes(text[i])) stack.push(text[i]);
    else if (')）'.includes(text[i])) {
      if (stack.pop() !== (text[i] === ')' ? '(' : '（')) return [];
    } else if (text[i] === '・' && stack.length === 0) {
      parts.push({ start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  if (stack.length) return [];
  parts.push({ start, text: text.slice(start) });
  return parts;
}

export function parseSegment(part) {
  const match = /^(\s*)([^()（）]+?)(?:\s*[(（]([^()（）]+)[)）])?\s*$/u.exec(
    part.text,
  );
  if (!match) return null;
  const heading = match[2].trimEnd();
  // Only explicit kana readings (and their separators) are supported.
  const readings = match[3]
    ? match[3].split(/[・、／/]/u).map((s) => s.trim())
    : [];
  if (
    readings.some((s) => !s || !/^(?:[ぁ-ゖァ-ヺー]|\u3099|\u309a)+$/u.test(s))
  )
    return null;
  return {
    heading,
    readings,
    start: part.start + match[1].length,
    length: part.text.trimEnd().length - match[1].length,
  };
}

export function linkDocument(document, dictionary) {
  if (
    document.location.origin !== ORIGIN ||
    !/^\/kanji\/\d{10}$/.test(document.location.pathname)
  )
    return 0;
  const headings = [...document.querySelectorAll('img[alt="下つき"]')];
  if (headings.length !== 1) return 0;
  const heading = headings[0];
  const li = heading.closest('li');
  if (
    !li ||
    heading.parentElement.tagName !== 'H4' ||
    heading.parentElement.parentElement !== li
  )
    return 0;
  const divs = [...li.children].filter((n) => n.tagName === 'DIV');
  if (
    divs.length !== 1 ||
    divs[0].children.length !== 1 ||
    divs[0].firstElementChild.tagName !== 'P'
  )
    return 0;
  const p = divs[0].firstElementChild;
  // Treat links as opaque protected ranges. Any other nested element is unverified.
  if ([...p.children].some((n) => n.tagName !== 'A')) return 0;
  const text = p.textContent;
  const offsets = [];
  let offset = 0;
  for (const node of p.childNodes) {
    offsets.push({
      node,
      start: offset,
      end: offset + node.textContent.length,
    });
    offset += node.textContent.length;
  }
  let count = 0;
  for (const segment of segments(text).reverse()) {
    const parsed = parseSegment(segment);
    if (!parsed) continue;
    const end = parsed.start + parsed.length;
    const span = offsets.filter(
      (item) =>
        item.end > segment.start &&
        item.start < segment.start + segment.text.length,
    );
    if (span.some((item) => item.node.nodeType !== 3)) continue;
    const containing = offsets.find(
      (item) =>
        item.node.nodeType === 3 &&
        parsed.start >= item.start &&
        end <= item.end,
    );
    if (!containing) continue;
    const path = chooseCandidate(dictionary, parsed.heading, parsed.readings);
    if (!path) continue;
    const range = document.createRange();
    range.setStart(containing.node, parsed.start - containing.start);
    range.setEnd(containing.node, end - containing.start);
    const a = document.createElement('a');
    a.href = new URL(path, ORIGIN).href;
    a.dataset.kanjipediaLink = '1';
    range.surroundContents(a);
    count++;
  }
  if (p.querySelector('a[href]')) p.dataset.kanjipediaShitatsuki = '1';
  return count;
}

if (typeof document !== 'undefined' && globalThis.__KANJIPEDIA_DATA__) {
  const start = performance.now();
  const count = linkDocument(document, globalThis.__KANJIPEDIA_DATA__);
  globalThis.__KANJIPEDIA_METRICS__ = {
    count,
    durationMs: performance.now() - start,
  };
}
