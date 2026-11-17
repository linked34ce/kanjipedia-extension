export const ORIGIN = 'https://www.kanjipedia.jp';
export const PARSER_VERSION = '1.1.0';

export function safePath(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, ORIGIN);
    return url.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/kotoba\/\d{10,11}$/.test(url.pathname)
      ? url.pathname
      : null;
  } catch {
    return null;
  }
}

export function headingKey(value) {
  // No NFKC/NFC: compatibility ideographs and IVS must remain distinct.
  const text = value.trim();
  let depth = 0;
  for (const char of text) {
    if (char === '〈' && ++depth > 1) return text;
    if (char === '〉' && --depth < 0) return text;
  }
  return depth ? text : text.replace(/[〈〉]/gu, '');
}

export function readingKey(value) {
  let text = value.trim();
  if (
    (text.startsWith('(') && text.endsWith(')')) ||
    (text.startsWith('（') && text.endsWith('）'))
  )
    text = text.slice(1, -1);
  return text
    .normalize('NFC')
    .replace(/[ぁ-ゖ]/gu, (char) =>
      String.fromCodePoint(char.codePointAt(0) + 0x60),
    );
}

export function chooseCandidate(dictionary, heading, readings = []) {
  const key = headingKey(heading);
  if (!Object.hasOwn(dictionary.entries, key)) return null;
  const candidates = dictionary.entries[key];
  if (!Array.isArray(candidates)) return null;
  const paths = new Set(
    candidates
      .filter(
        (item) =>
          safePath(item.path) &&
          (!readings.length || readings.map(readingKey).includes(item.reading)),
      )
      .map((item) => item.path),
  );
  // Multiple supplied readings must all independently resolve to the same URL.
  if (
    readings.some(
      (reading) =>
        !candidates.some(
          (item) => item.reading === readingKey(reading) && safePath(item.path),
        ),
    )
  )
    return null;
  return paths.size === 1 ? [...paths][0] : null;
}

export function stableDictionary(records) {
  const entries = new Map();
  for (const record of records) {
    if (!safePath(record.path) || !record.reading)
      throw new Error('Unsafe record');
    for (const variant of record.variants) {
      const key = headingKey(variant);
      if (!key) continue;
      if (!entries.has(key)) entries.set(key, new Map());
      entries.get(key).set(`${record.path}\0${record.reading}`, {
        path: record.path,
        reading: record.reading,
      });
    }
  }
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    schemaVersion: 1,
    entries: Object.fromEntries(
      sorted.map(([key, values]) => [
        key,
        [...values.values()].sort((a, b) =>
          a.path < b.path
            ? -1
            : a.path > b.path
              ? 1
              : a.reading < b.reading
                ? -1
                : a.reading > b.reading
                  ? 1
                  : 0,
        ),
      ]),
    ),
  };
}
