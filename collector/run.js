import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractSearch, searchURL } from './extract.js';
import { atomicWrite, writeJSON, hash } from './store.js';
import { Stop } from './http.js';
import { stableDictionary, PARSER_VERSION } from '../shared/core.js';
import { validateDictionary } from '../scripts/build.js';

export function createRun(prefixes, { full = false, seedPage = 1 } = {}) {
  return {
    runId: randomUUID(), createdAt: new Date().toISOString(), parserVersion: PARSER_VERSION,
    full, prefixPlan: prefixes, queue: prefixes.map(({ prefix }) => ({
      prefix, page: seedPage, conditions: 'wy=1&sk=leftHand', state: 'pending', attempts: 0
    })), diagnostics: [], complete: false
  };
}
export const jobStem = (prefix, page) => `${[...prefix].map(c => c.codePointAt(0).toString(16)).join('_')}-${page}`;
export function addPage(run, prefix, page) {
  if (!run.queue.some(job => job.prefix === prefix && job.page === page))
    run.queue.push({ prefix, page, conditions: 'wy=1&sk=leftHand', state: 'pending', attempts: 0 });
}
export function acceptPage(run, job, parsed) {
  const others = run.queue.filter(j => j !== job && j.prefix === job.prefix && j.state === 'done');
  if (others.some(j => j.bodyHash === job.bodyHash)) throw new Stop('Repeated page body');
  if (others.some(j => j.parsed.total !== parsed.total)) throw new Stop('Result total changed; create a new run');
  const lastPage = parsed.page < parsed.lastPage
    ? Math.max(parsed.lastPage, Math.ceil(parsed.total / parsed.rowCount)) : parsed.lastPage;
  if (lastPage > 100_000) throw new Stop('Implausible page range');
  if (others.some(j => j.parsed.lastPage !== lastPage)) throw new Stop('Page range changed');
  parsed.lastPage = lastPage;
  if (job.page < lastPage && others.some(j => j.page < lastPage && j.parsed.rowCount !== parsed.rowCount))
    throw new Stop('Page size changed');
  job.parsed = parsed;
  job.state = 'done';
  job.parserVersion = PARSER_VERSION;
  for (let page = 1; page <= lastPage; page++) addPage(run, job.prefix, page);
  const report = reportRun(run);
  const current = report.prefixes.find(p => p.prefix === job.prefix);
  if (!current.missingPages.length && !current.consistent) {
    job.state = 'failed';
    throw new Stop('Page rows/unique URLs do not account for total');
  }
  run.complete = reportRun(run).complete;
}

export async function processRun(run, directory, gate, { reparse = false, cancelled = () => false, progress = () => {} } = {}) {
  const save = () => writeJSON(path.join(directory, 'run.json'), run);
  if (reparse) {
    // Revalidate all saved evidence with the current parser as one generation.
    for (const job of run.queue) if (job.bodyFile) { job.state = 'inflight'; delete job.parsed; }
  }
  for (let index = 0; index < run.queue.length; index++) {
    const job = run.queue[index];
    if (cancelled()) throw new Stop('Interrupted; queue saved', 2);
    if (job.state === 'done') continue;
    if (job.state === 'failed' && job.attempts >= 3 && !reparse) throw new Stop('Exhausted page; investigate before a new run');
    try {
      let html;
      // Evidence is saved before metadata and before done. The stable per-job filename
      // lets recovery detect a response even if the final state write was interrupted.
      const stem = jobStem(job.prefix, job.page);
      const evidenceFile = path.join(directory, `${stem}.response.json`);
      let evidence;
      try { evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (evidence) {
        try { html = await fs.readFile(path.join(directory, `${stem}.html`), 'utf8'); }
        catch (error) {
          if (error.code !== 'ENOENT' || typeof evidence.body !== 'string') throw error;
          html = evidence.body;
          if (hash(html) !== evidence.bodyHash) throw new Stop('Saved envelope hash mismatch');
          await atomicWrite(path.join(directory, `${stem}.html`), html);
        }
        if (hash(html) !== evidence.bodyHash) throw new Stop('Saved HTML hash mismatch');
      } else {
        if (reparse) { job.state = 'pending'; continue; }
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
            // Retry delay is persisted, so a restart cannot bypass it.
            gate.state.nextAt = Math.max(gate.state.nextAt ?? 0,
              gate.now() + (job.attempts === 1 ? 60_000 : 180_000) + gate.random() * 5000);
            await gate.save(gate.state);
            continue;
          }
          job.attempts++;
          job.httpAttempts = (job.httpAttempts ?? 0) + gate.used - usedBefore;
          html = result.body;
          evidence = { ...result, body: undefined, bodyHash: hash(html) };
          // One atomic envelope is the crash-recovery authority; the separate HTML
          // file can always be reconstructed without making another HTTP request.
          await writeJSON(evidenceFile, { ...evidence, body: html });
          await atomicWrite(path.join(directory, `${stem}.html`), html);
          break;
        }
      }
      Object.assign(job, { bodyFile: `${stem}.html`, bodyHash: evidence.bodyHash,
        fetchedAt: evidence.fetchedAt, status: evidence.status, url: evidence.url });
      let parsed;
      try {
        parsed = extractSearch(html, { prefix: job.prefix, page: job.page,
          verifiedVariants: run.verifiedVariants ?? [],
          searchURL: evidence.url, fetchedAt: evidence.fetchedAt, bodyHash: evidence.bodyHash });
      } catch (error) { throw new Stop(`Extraction stopped: ${error.message}`); }
      acceptPage(run, job, parsed);
      delete job.error;
      await save();
      progress({ prefix: job.prefix, page: job.page, lastPage: parsed.lastPage, rows: parsed.rowCount,
        done: run.queue.filter(j => j.state === 'done').length, queued: run.queue.length });
    } catch (error) {
      job.state = error instanceof Stop && error.code === 2 ? 'pending' : 'failed';
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
  const prefixes = run.prefixPlan.map(plan => {
    const jobs = run.queue.filter(j => j.prefix === plan.prefix);
    const done = jobs.filter(j => j.state === 'done');
    const total = done[0]?.parsed.total ?? null;
    const pages = done[0]?.parsed.lastPage ?? null;
    const rows = done.reduce((n, j) => n + j.parsed.rowCount, 0);
    const paths = done.flatMap(j => [...j.parsed.records, ...j.parsed.diagnostics].map(r => r.path));
    const uniqueURLs = new Set(paths).size;
    const missingPages = pages ? Array.from({ length: pages }, (_, i) => i + 1)
      .filter(page => !done.some(j => j.page === page)) : [1];
    return { ...plan, verification: !missingPages.length ? 'verified' : 'unconfirmed', total, pages,
      rows, uniqueURLs, duplicateRows: paths.length - uniqueURLs, missingPages,
      consistent: total !== null && rows === total && uniqueURLs === total &&
        done.every(j => j.parsed.total === total && j.parsed.lastPage === pages),
      unresolved: done.reduce((n, j) => n + j.parsed.diagnostics.length, 0) };
  });
  const records = run.queue.filter(j => j.state === 'done').flatMap(j => j.parsed.records);
  const byPath = new Map(), conflicts = [];
  for (const record of records) {
    const signature = JSON.stringify([record.variants, record.reading]);
    if (byPath.has(record.path) && byPath.get(record.path) !== signature && !conflicts.includes(record.path)) conflicts.push(record.path);
    byPath.set(record.path, signature);
  }
  return { runId: run.runId, complete: prefixes.length > 0 && prefixes.every(p =>
    !p.missingPages.length && p.consistent) && run.queue.every(j => j.state === 'done') && !conflicts.length,
    prefixes, records: records.length, uniqueURLs: new Set(records.map(r => r.path)).size,
    conflicts, unresolved: prefixes.reduce((n, p) => n + p.unresolved, 0) };
}

export async function exportRun(run, outputRoot, { partial = false } = {}) {
  const report = reportRun(run);
  if (!report.complete && !partial) throw new Stop('Incomplete run; use --partial for a separate local output', 2);
  const records = run.queue.filter(j => j.state === 'done').flatMap(j => j.parsed.records);
  const excluded = new Set(report.conflicts);
  const dictionary = stableDictionary(records.filter(r => !excluded.has(r.path)));
  await validateDictionary(dictionary);
  const body = `${JSON.stringify(dictionary, null, 2)}\n`;
  const directory = path.join(outputRoot, partial ? 'partial' : 'generations', run.runId);
  const fetchedTimes = run.queue.filter(j => j.state === 'done').map(j => j.fetchedAt).filter(Boolean).sort();
  const manifest = { ...report, schemaVersion: 1, parserVersion: PARSER_VERSION,
    sha256: hash(body), generatedAt: new Date().toISOString(), runCreatedAt: run.createdAt,
    startedAt: fetchedTimes[0] ?? null, finishedAt: fetchedTimes.at(-1) ?? null,
    dictionaryKeys: Object.keys(dictionary.entries).length,
    redistribution: 'unresolved-private-local-only' };
  await atomicWrite(path.join(directory, 'dictionary.json'), body);
  await writeJSON(path.join(directory, 'manifest.json'), manifest);
  // Publish a pointer only after both generation artifacts are durable.
  if (!partial) await writeJSON(path.join(outputRoot, 'current.json'), {
    directory: path.join('generations', run.runId), sha256: manifest.sha256
  });
  return { directory, ...manifest };
}
