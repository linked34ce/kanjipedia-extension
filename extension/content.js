(() => {
  // shared/core.js
  var ORIGIN = "https://www.kanjipedia.jp";
  function safePath(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value, ORIGIN);
      return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && /^\/kotoba\/\d{10,11}$/.test(url.pathname) ? url.pathname : null;
    } catch {
      return null;
    }
  }
  function headingKey(value) {
    const text = value.trim();
    let depth = 0;
    for (const char of text) {
      if (char === "\u3008" && ++depth > 1) return text;
      if (char === "\u3009" && --depth < 0) return text;
    }
    return depth ? text : text.replace(/[〈〉]/gu, "");
  }
  function readingKey(value) {
    let text = value.trim();
    if (text.startsWith("(") && text.endsWith(")") || text.startsWith("\uFF08") && text.endsWith("\uFF09"))
      text = text.slice(1, -1);
    return text.normalize("NFC").replace(
      /[ぁ-ゖ]/gu,
      (char) => String.fromCodePoint(char.codePointAt(0) + 96)
    );
  }
  function chooseCandidate(dictionary, heading, readings = []) {
    const key = headingKey(heading);
    if (!Object.hasOwn(dictionary.entries, key)) return null;
    const candidates = dictionary.entries[key];
    if (!Array.isArray(candidates)) return null;
    const paths = new Set(
      candidates.filter(
        (item) => safePath(item.path) && (!readings.length || readings.map(readingKey).includes(item.reading))
      ).map((item) => item.path)
    );
    if (readings.some(
      (reading) => !candidates.some(
        (item) => item.reading === readingKey(reading) && safePath(item.path)
      )
    ))
      return null;
    return paths.size === 1 ? [...paths][0] : null;
  }

  // extension/source.js
  function segments(text) {
    const parts = [];
    let start = 0;
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if ("(\uFF08".includes(text[i])) stack.push(text[i]);
      else if (")\uFF09".includes(text[i])) {
        if (stack.pop() !== (text[i] === ")" ? "(" : "\uFF08")) return [];
      } else if (text[i] === "\u30FB" && stack.length === 0) {
        parts.push({ start, text: text.slice(start, i) });
        start = i + 1;
      }
    }
    if (stack.length) return [];
    parts.push({ start, text: text.slice(start) });
    return parts;
  }
  function parseSegment(part) {
    const match = /^(\s*)([^()（）]+?)(?:\s*[(（]([^()（）]+)[)）])?\s*$/u.exec(
      part.text
    );
    if (!match) return null;
    const heading = match[2].trimEnd();
    const readings = match[3] ? match[3].split(/[・、／/]/u).map((s) => s.trim()) : [];
    if (readings.some((s) => !s || !/^(?:[ぁ-ゖァ-ヺー]|\u3099|\u309a)+$/u.test(s)))
      return null;
    return {
      heading,
      readings,
      start: part.start + match[1].length,
      length: part.text.trimEnd().length - match[1].length
    };
  }
  function findTargetParagraph(document2) {
    if (document2.location.origin !== ORIGIN || !/^\/kanji\/\d{10}$/.test(document2.location.pathname))
      return null;
    const headings = [...document2.querySelectorAll('img[alt="\u4E0B\u3064\u304D"]')];
    if (headings.length !== 1) return null;
    const heading = headings[0];
    const li = heading.closest("li");
    if (!li || heading.parentElement.tagName !== "H4" || heading.parentElement.parentElement !== li)
      return null;
    const divs = [...li.children].filter((n) => n.tagName === "DIV");
    if (divs.length !== 1 || divs[0].children.length !== 1 || divs[0].firstElementChild.tagName !== "P")
      return null;
    const p = divs[0].firstElementChild;
    if ([...p.children].some((n) => n.tagName !== "A")) return null;
    return p;
  }
  function childTextOffsets(paragraph) {
    const offsets = [];
    let offset = 0;
    for (const node of paragraph.childNodes) {
      offsets.push({
        node,
        start: offset,
        end: offset + node.textContent.length
      });
      offset += node.textContent.length;
    }
    return offsets;
  }
  function containingTextNode(offsets, segment, parsed) {
    const span = offsets.filter(
      (item) => item.end > segment.start && item.start < segment.start + segment.text.length
    );
    if (span.some((item) => item.node.nodeType !== 3)) return null;
    return offsets.find(
      (item) => item.node.nodeType === 3 && parsed.start >= item.start && parsed.start + parsed.length <= item.end
    );
  }
  function surroundLink(document2, containing, parsed, path) {
    const range = document2.createRange();
    range.setStart(containing.node, parsed.start - containing.start);
    range.setEnd(
      containing.node,
      parsed.start + parsed.length - containing.start
    );
    const a = document2.createElement("a");
    a.href = new URL(path, ORIGIN).href;
    a.dataset.kanjipediaLink = "1";
    range.surroundContents(a);
  }
  function linkDocument(document2, dictionary) {
    const p = findTargetParagraph(document2);
    if (!p) return 0;
    const text = p.textContent;
    const offsets = childTextOffsets(p);
    let count = 0;
    for (const segment of segments(text).reverse()) {
      const parsed = parseSegment(segment);
      if (!parsed) continue;
      const containing = containingTextNode(offsets, segment, parsed);
      if (!containing) continue;
      const path = chooseCandidate(dictionary, parsed.heading, parsed.readings);
      if (!path) continue;
      surroundLink(document2, containing, parsed, path);
      count++;
    }
    if (p.querySelector("a[href]")) p.dataset.kanjipediaShitatsuki = "1";
    return count;
  }
  if (typeof document !== "undefined" && globalThis.__KANJIPEDIA_DATA__) {
    const start = performance.now();
    const count = linkDocument(document, globalThis.__KANJIPEDIA_DATA__);
    globalThis.__KANJIPEDIA_METRICS__ = {
      count,
      durationMs: performance.now() - start
    };
  }
})();
