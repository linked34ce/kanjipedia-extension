import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractSearch, searchURL } from './extract.js';
import { atomicWrite, readJSON, writeJSON, hash } from './store.js';
import { Stop, scheduleRetry } from './http.js';
import { stableDictionary, PARSER_VERSION } from '../shared/core.js';
import { validateDictionary } from '../scripts/dictionary.js';

export function createRun(prefixes, { full = false, seedPage = 1 } = {}) {
  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    full,
    prefixPlan: prefixes,
    queue: prefixes.map(({ prefix }) => ({
      prefix,
      page: seedPage,
      conditions: 'wy=1&sk=leftHand',
      state: 'pending',
      attempts: 0,
    })),
    diagnostics: [],
    complete: false,
  };
}
export const jobStem = (prefix, page) =>
  `${[...prefix].map((c) => c.codePointAt(0).toString(16)).join('_')}-${page}`;

function pageFiles(directory, job) {
  const stem = jobStem(job.prefix, job.page);
  return {
    bodyFile: `${stem}.html`,
    html: path.join(directory, `${stem}.html`),
    evidence: path.join(directory, `${stem}.response.json`),
  };
}

async function restorePage(files) {
  const evidence = await readJSON(files.evidence, null);
  if (!evidence) return null;
  let html;
  try {
    html = await fs.readFile(files.html, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' || typeof evidence.body !== 'string')
      throw error;
    html = evidence.body;
    if (hash(html) !== evidence.bodyHash)
      throw new Stop('Saved envelope hash mismatch');
    await atomicWrite(files.html, html);
  }
  if (hash(html) !== evidence.bodyHash)
    throw new Stop('Saved HTML hash mismatch');
  return { html, evidence };
}

async function fetchPage(job, files, gate, save) {
  await gate.ensureRobots('https://www.kanjipedia.jp');
  job.state = 'inflight';
  await save();
  for (;;) {
    const usedBefore = gate.used;
    let result;
    try {
      result = await gate.get(searchURL(job.prefix, job.page));
    } catch (error) {
      if (gate.used > usedBefore) job.attempts++;
      job.httpAttempts = (job.httpAttempts ?? 0) + gate.used - usedBefore;
      job.error = error.message;
      job.status = error.response?.status;
      await save();
      if (!error.retryable || job.attempts >= 3) throw error;
      await scheduleRetry(gate, job.attempts);
      continue;
    }
    job.attempts++;
    job.httpAttempts = (job.httpAttempts ?? 0) + gate.used - usedBefore;
    const html = result.body;
    const evidence = { ...result, body: undefined, bodyHash: hash(html) };
    // Save the atomic envelope first: HTML alone cannot recover a response's metadata.
    await writeJSON(files.evidence, { ...evidence, body: html });
    await atomicWrite(files.html, html);
    return { html, evidence };
  }
}

function parsePage(run, job, { html, evidence }) {
  try {
    return extractSearch(html, {
      prefix: job.prefix,
      page: job.page,
      verifiedVariants: run.verifiedVariants ?? [],
      searchURL: evidence.url,
      fetchedAt: evidence.fetchedAt,
      bodyHash: evidence.bodyHash,
    });
  } catch (error) {
    throw new Stop(`Extraction stopped: ${error.message}`);
  }
}
export function addPage(run, prefix, page) {
  if (!run.queue.some((job) => job.prefix === prefix && job.page === page))
    run.queue.push({
      prefix,
      page,
      conditions: 'wy=1&sk=leftHand',
      state: 'pending',
      attempts: 0,
    });
}
export function acceptPage(run, job, parsed) {
  const others = run.queue.filter(
    (j) => j !== job && j.prefix === job.prefix && j.state === 'done',
  );
  if (others.some((j) => j.bodyHash === job.bodyHash))
    throw new Stop('Repeated page body');
  if (others.some((j) => j.parsed.total !== parsed.total))
    throw new Stop('Result total changed; create a new run');
  const lastPage =
    parsed.page < parsed.lastPage
      ? Math.max(parsed.lastPage, Math.ceil(parsed.total / parsed.rowCount))
      : parsed.lastPage;
  if (lastPage > 100_000) throw new Stop('Implausible page range');
  if (others.some((j) => j.parsed.lastPage !== lastPage))
    throw new Stop('Page range changed');
  parsed.lastPage = lastPage;
  if (
    job.page < lastPage &&
    others.some(
      (j) => j.page < lastPage && j.parsed.rowCount !== parsed.rowCount,
    )
  )
    throw new Stop('Page size changed');
  job.parsed = parsed;
  job.state = 'done';
  job.parserVersion = PARSER_VERSION;
  for (let page = 1; page <= lastPage; page++) addPage(run, job.prefix, page);
  const report = reportRun(run);
  const current = report.prefixes.find((p) => p.prefix === job.prefix);
  if (!current.missingPages.length && !current.consistent) {
    job.state = 'failed';
    throw new Stop('Page rows/unique URLs do not account for total');
  }
  run.complete = reportRun(run).complete;
}

export async function processRun(
  run,
  directory,
  gate,
  { reparse = false, cancelled = () => false, progress = () => {} } = {},
) {
  const save = () => writeJSON(path.join(directory, 'run.json'), run);
  if (reparse) {
    // Revalidate all saved evidence with the current parser as one generation.
    for (const job of run.queue)
      if (job.bodyFile) {
        job.state = 'inflight';
        delete job.parsed;
      }
  }
  for (let index = 0; index < run.queue.length; index++) {
    const job = run.queue[index];
    if (cancelled()) throw new Stop('Interrupted; queue saved', 2);
    if (job.state === 'done') continue;
    if (job.state === 'failed' && job.attempts >= 3 && !reparse)
      throw new Stop('Exhausted page; investigate before a new run');
    try {
      // Stable filenames recover a saved response even if run.json was not updated.
      const files = pageFiles(directory, job);
      let page = await restorePage(files);
      if (!page) {
        if (reparse) {
          job.state = 'pending';
          continue;
        }
        page = await fetchPage(job, files, gate, save);
      }
      const { evidence } = page;
      Object.assign(job, {
        bodyFile: files.bodyFile,
        bodyHash: evidence.bodyHash,
        fetchedAt: evidence.fetchedAt,
        status: evidence.status,
        url: evidence.url,
      });
      const parsed = parsePage(run, job, page);
      acceptPage(run, job, parsed);
      delete job.error;
      await save();
      progress({
        prefix: job.prefix,
        page: job.page,
        lastPage: parsed.lastPage,
        rows: parsed.rowCount,
        done: run.queue.filter((j) => j.state === 'done').length,
        queued: run.queue.length,
      });
    } catch (error) {
      job.state =
        error instanceof Stop && error.code === 2 ? 'pending' : 'failed';
      job.error = error.message;
      run.complete = false;
      await save();
      throw error;
    }
  }
  run.complete = reportRun(run).complete;
  await save();
  return reportRun(run);
}

export function reportRun(run) {
  const prefixes = run.prefixPlan.map((plan) => {
    const jobs = run.queue.filter((j) => j.prefix === plan.prefix);
    const done = jobs.filter((j) => j.state === 'done');
    const total = done[0]?.parsed.total ?? null;
    const pages = done[0]?.parsed.lastPage ?? null;
    const rows = done.reduce((n, j) => n + j.parsed.rowCount, 0);
    const paths = done.flatMap((j) =>
      [...j.parsed.records, ...j.parsed.diagnostics].map((r) => r.path),
    );
    const uniqueURLs = new Set(paths).size;
    const missingPages = pages
      ? Array.from({ length: pages }, (_, i) => i + 1).filter(
          (page) => !done.some((j) => j.page === page),
        )
      : [1];
    return {
      ...plan,
      verification: !missingPages.length ? 'verified' : 'unconfirmed',
      total,
      pages,
      rows,
      uniqueURLs,
      duplicateRows: paths.length - uniqueURLs,
      missingPages,
      consistent:
        total !== null &&
        rows === total &&
        uniqueURLs === total &&
        done.every(
          (j) => j.parsed.total === total && j.parsed.lastPage === pages,
        ),
      unresolved: done.reduce((n, j) => n + j.parsed.diagnostics.length, 0),
    };
  });
  const records = run.queue
    .filter((j) => j.state === 'done')
    .flatMap((j) => j.parsed.records);
  const byPath = new Map(),
    conflicts = [];
  for (const record of records) {
    const signature = JSON.stringify([record.variants, record.reading]);
    if (
      byPath.has(record.path) &&
      byPath.get(record.path) !== signature &&
      !conflicts.includes(record.path)
    )
      conflicts.push(record.path);
    byPath.set(record.path, signature);
  }
  return {
    runId: run.runId,
    complete:
      prefixes.length > 0 &&
      prefixes.every((p) => !p.missingPages.length && p.consistent) &&
      run.queue.every((j) => j.state === 'done') &&
      !conflicts.length,
    prefixes,
    records: records.length,
    uniqueURLs: new Set(records.map((r) => r.path)).size,
    conflicts,
    unresolved: prefixes.reduce((n, p) => n + p.unresolved, 0),
  };
}

export async function exportRun(run, outputRoot, { partial = false } = {}) {
  const report = reportRun(run);
  if (!report.complete && !partial)
    throw new Stop(
      'Incomplete run; use --partial for a separate local output',
      2,
    );
  const records = run.queue
    .filter((j) => j.state === 'done')
    .flatMap((j) => j.parsed.records);
  const excluded = new Set(report.conflicts);
  const dictionary = stableDictionary(
    records.filter((r) => !excluded.has(r.path)),
  );
  await validateDictionary(dictionary);
  const body = `${JSON.stringify(dictionary, null, 2)}\n`;
  const directory = path.join(
    outputRoot,
    partial ? 'partial' : 'generations',
    run.runId,
  );
  const fetchedTimes = run.queue
    .filter((j) => j.state === 'done')
    .map((j) => j.fetchedAt)
    .filter(Boolean)
    .sort();
  const manifest = {
    ...report,
    schemaVersion: 1,
    parserVersion: PARSER_VERSION,
    sha256: hash(body),
    generatedAt: new Date().toISOString(),
    runCreatedAt: run.createdAt,
    startedAt: fetchedTimes[0] ?? null,
    finishedAt: fetchedTimes.at(-1) ?? null,
    dictionaryKeys: Object.keys(dictionary.entries).length,
    redistribution: 'github-only-user-approved',
  };
  await atomicWrite(path.join(directory, 'dictionary.json'), body);
  await writeJSON(path.join(directory, 'manifest.json'), manifest);
  // Publish a pointer only after both generation artifacts are durable.
  if (!partial)
    await writeJSON(path.join(outputRoot, 'current.json'), {
      directory: path.join('generations', run.runId),
      sha256: manifest.sha256,
    });
  return { directory, ...manifest };
}
