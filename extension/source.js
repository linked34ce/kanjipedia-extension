import { chooseCandidate, ORIGIN } from '../shared/core.js';

// 読みの中の中点で語を分割しないよう、括弧の対応を確認する。
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
  // 明示された仮名の読みと区切り文字だけを扱う。
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

function findTargetParagraph(document) {
  if (
    document.location.origin !== ORIGIN ||
    !/^\/kanji\/\d{10}$/.test(document.location.pathname)
  )
    return null;

  const headings = [...document.querySelectorAll('img[alt="下つき"]')];

  if (headings.length !== 1) return null;

  const heading = headings[0];
  const li = heading.closest('li');

  if (
    !li ||
    heading.parentElement.tagName !== 'H4' ||
    heading.parentElement.parentElement !== li
  )
    return null;

  const divs = [...li.children].filter((n) => n.tagName === 'DIV');

  if (
    divs.length !== 1 ||
    divs[0].children.length !== 1 ||
    divs[0].firstElementChild.tagName !== 'P'
  )
    return null;

  const p = divs[0].firstElementChild;

  // 既存リンクの内部は変更しない。他の入れ子要素は構造を未確認のため扱わない。
  if ([...p.children].some((n) => n.tagName !== 'A')) return null;

  return p;
}

function childTextOffsets(paragraph) {
  const offsets = [];
  let offset = 0;

  for (const node of paragraph.childNodes) {
    offsets.push({
      node,
      start: offset,
      end: offset + node.textContent.length,
    });
    offset += node.textContent.length;
  }

  return offsets;
}

function containingTextNode(offsets, segment, parsed) {
  const span = offsets.filter(
    (item) =>
      item.end > segment.start &&
      item.start < segment.start + segment.text.length,
  );

  if (span.some((item) => item.node.nodeType !== 3)) return null;

  return offsets.find(
    (item) =>
      item.node.nodeType === 3 &&
      parsed.start >= item.start &&
      parsed.start + parsed.length <= item.end,
  );
}

function surroundLink(document, containing, parsed, path) {
  const range = document.createRange();

  range.setStart(containing.node, parsed.start - containing.start);
  range.setEnd(
    containing.node,
    parsed.start + parsed.length - containing.start,
  );

  const a = document.createElement('a');

  a.href = new URL(path, ORIGIN).href;
  a.dataset.kanjipediaLink = '1';
  range.surroundContents(a);
}

export function linkDocument(document, dictionary) {
  const p = findTargetParagraph(document);

  if (!p) return 0;

  const text = p.textContent;
  const offsets = childTextOffsets(p);
  let count = 0;

  // 先頭側の位置がずれないよう、末尾からリンクを挿入する。
  for (const segment of segments(text).reverse()) {
    const parsed = parseSegment(segment);

    if (!parsed) continue;

    const containing = containingTextNode(offsets, segment, parsed);

    if (!containing) continue;

    const path = chooseCandidate(dictionary, parsed.heading, parsed.readings);

    if (!path) continue;

    surroundLink(document, containing, parsed, path);
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
