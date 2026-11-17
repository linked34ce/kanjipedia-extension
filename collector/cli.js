import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { root, buildExtension, validateDictionary } from '../scripts/build.js';
import { acquireLock, readJSON, writeJSON, atomicWrite, hash } from './store.js';
import { HttpGate, Stop } from './http.js';
import { createRun, processRun, reportRun, exportRun, addPage, jobStem } from './run.js';
import { PREFIXES } from './prefixes.js';
import { searchURL, extractSearch, searchPage } from './extract.js';
import { reviewVariants } from './review.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' },
  refresh: { type: 'boolean' },
  run: { type: 'string' }, prefixes: { type: 'string' }, full: { type: 'boolean' },
  partial: { type: 'boolean' }, 'max-requests': { type: 'string' }, group: { type: 'string' },
  input: { type: 'string' }, 'seed-page': { type: 'string' }, 'from-survey': { type: 'boolean' },
  path: { type: 'string' }, variants: { type: 'string' }
} });
const command = values.help ? 'help' : positionals[0] ?? 'help';
const local = path.join(root, '.local');
const runDirectory = id => {
  if (!/^[a-zA-Z0-9-]+$/.test(id ?? '')) throw new Error('Provide --run RUN_ID');
  return path.join(local, 'runs', id);
};
const print = value => console.log(JSON.stringify(value, null, 2));
let release;
let cancelled = false;
process.on('SIGINT', () => { cancelled = true; });

try {
  if (command === 'help') {
    console.log('survey [--group terms|search|kana|article|target] [--refresh] [--max-requests 10]\ncollect [--prefixes あ,か] [--full] [--from-survey] [--seed-page 2] [--max-requests 10]\nresume --run ID [--max-requests 10]\nreparse --run ID (offline)\nreport --run ID\nexport --run ID [--partial]\nbuild [--input FILE]\nvalidate [--input FILE]\nreview-variants --path /kotoba/0005614200 --variants 白亜,白堊 (offline)\nreset-failures (preserves cooldown and daily budget)');
  } else if (command === 'build' || command === 'validate') {
    let input = values.input;
    if (!input) {
      input = path.join(root, 'data/published/dictionary.json');
      try { await fs.access(input); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const current = await readJSON(path.join(root, 'data/current.json'));
        input = path.join(root, 'data', current.directory, 'dictionary.json');
        if (hash(await fs.readFile(input)) !== current.sha256) throw new Error('Current generation hash mismatch', { cause: error });
      }
    }
    print(command === 'build' ? await buildExtension({ input }) :
      { valid: Boolean(await validateDictionary(await readJSON(input))) });
  } else if (command === 'report') {
    print(reportRun(await readJSON(path.join(runDirectory(values.run), 'run.json'))));
  } else {
    release = await acquireLock(local);
    const limit = Number(values['max-requests'] ?? 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Request limit must be 1..500');
    const gate = new HttpGate({ state: await readJSON(path.join(local, 'gate.json'), {}),
      save: state => writeJSON(path.join(local, 'gate.json'), state), maxRequests: limit, cancelled: () => cancelled,
      recordResponse: async result => {
        const id = `${Date.now()}-${hash(result.url).slice(0, 16)}`;
        await atomicWrite(path.join(local, 'http', `${id}.html`), result.body);
        await writeJSON(path.join(local, 'http', `${id}.json`), { ...result, body: undefined, bodyHash: hash(result.body) });
      } });
    if (command === 'survey') {
      const groups = {
        terms: ['https://www.kanjipedia.jp/howto/about.html', 'https://www.kanjipedia.jp/include/menu.html',
          'https://www.kanken.or.jp/policy/', 'https://www.kanken.or.jp/sitelink/'],
        search: [searchURL('あ'), searchURL('あ', 1, true), searchURL('あ', 2)],
        kana: ['か', 'が', 'は', 'ば', 'ぱ'].map(k => searchURL(k)),
        article: ['https://www.kanjipedia.jp/kanji/0000000500', 'https://www.kanjipedia.jp/kotoba/0005614200']
        , target: [searchURL('はくあ')]
      };
      const urls = groups[values.group ?? 'terms'];
      if (!urls) throw new Error('Unknown survey group');
      const refreshedOrigins = new Set();
      const describe = async evidence => {
        const url = new URL(evidence.url);
        if (url.pathname !== '/search' || evidence.status !== 200) return;
        const html = await fs.readFile(path.join(local, 'survey', evidence.bodyFile), 'utf8');
        if (hash(html) !== evidence.bodyHash) throw new Error('Survey hash mismatch');
        const prefix = url.searchParams.get('k');
        const parsed = extractSearch(html, { prefix, page: searchPage(url, prefix) });
        print({ prefix, page: parsed.page, total: parsed.total, lastPage: parsed.lastPage,
          rowCount: parsed.rowCount, unresolved: parsed.diagnostics.length });
        if ((values.group ?? 'terms') === 'search' && !urls.includes(searchURL(prefix, parsed.lastPage)))
          urls.push(searchURL(prefix, parsed.lastPage));
      };
      for (const url of urls) {
        if (cancelled) throw new Stop('Interrupted', 2);
        const evidenceId = hash(url);
        const file = path.join(local, 'survey', `${evidenceId}.json`);
        if (!values.refresh) {
          try { const existing = await readJSON(file); print({ cached: true, ...existing }); await describe(existing); continue; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const origin = new URL(url).origin;
        await gate.ensureRobots(origin, { force: Boolean(values.refresh) && !refreshedOrigins.has(origin) });
        refreshedOrigins.add(origin);
        let result;
        try { result = await gate.get(url); }
        catch (error) {
          if (!error.response) throw error;
          result = error.response; // survey records a 5xx once without retrying it
        }
        const bodyFile = `${evidenceId}.html`;
        await atomicWrite(path.join(local, 'survey', bodyFile), result.body);
        const evidence = { ...result, body: undefined, bodyFile, bodyHash: hash(result.body) };
        await writeJSON(file, evidence);
        print(evidence);
        await describe(evidence);
      }
    } else if (command === 'review-variants') {
      const review = await reviewVariants(path.join(local, 'survey'), values.path, (values.variants ?? '').split(','));
      const file = path.join(local, 'verified-variants.json');
      const existing = await readJSON(file, []);
      await writeJSON(file, [...existing.filter(v => v.path !== review.path), review]);
      print(review);
    } else if (command === 'reset-failures') {
      gate.state.consecutiveFailures = 0;
      await gate.save(gate.state);
      print({ reset: true, cooldownUntil: gate.state.cooldownUntil });
    } else if (['collect', 'resume', 'reparse', 'export'].includes(command)) {
      let run;
      if (command === 'collect') {
        const requested = (values.prefixes ?? (values.full ? '' : 'あ')).split(',').filter(Boolean);
        if (requested.some(prefix => !/^[ぁ-ゖ]{1,16}$/u.test(prefix))) throw new Error('Prefix must be 1..16 hiragana');
        const selected = [...(values.full ? PREFIXES : [])];
        for (const prefix of new Set(requested)) if (!selected.some(p => p.prefix === prefix))
          selected.push(PREFIXES.find(p => p.prefix === prefix) ?? {
            prefix, status: 'target', verification: 'unconfirmed', reason: '明示された検索範囲'
          });
        if (!selected.length) throw new Error('Provide at least one prefix');
        const seedPage = Number(values['seed-page'] ?? 1);
        if (!Number.isSafeInteger(seedPage) || seedPage < 1) throw new Error('Invalid seed page');
        run = createRun(selected, { full: Boolean(values.full), seedPage });
        run.verifiedVariants = await readJSON(path.join(local, 'verified-variants.json'), []);
        if (values['from-survey']) {
          const surveyDirectory = path.join(local, 'survey');
          for (const file of await fs.readdir(surveyDirectory)) {
            if (!file.endsWith('.json')) continue;
            const evidence = await readJSON(path.join(surveyDirectory, file));
            const url = new URL(evidence.url);
            if (url.pathname !== '/search' || evidence.status !== 200) continue;
            const prefix = url.searchParams.get('k');
            if (!selected.some(p => p.prefix === prefix)) continue;
            const page = searchPage(url, prefix);
            addPage(run, prefix, page);
            const stem = jobStem(prefix, page);
            const html = await fs.readFile(path.join(surveyDirectory, evidence.bodyFile), 'utf8');
            if (hash(html) !== evidence.bodyHash) throw new Error('Survey hash mismatch');
            const directory = runDirectory(run.runId);
            await atomicWrite(path.join(directory, `${stem}.html`), html);
            await writeJSON(path.join(directory, `${stem}.response.json`), evidence);
            Object.assign(run.queue.find(j => j.prefix === prefix && j.page === page), {
              state: 'inflight', bodyFile: `${stem}.html`, bodyHash: evidence.bodyHash
            });
          }
          // Process all imported evidence offline before spending the request budget.
          run.queue.sort((a, b) => Number(Boolean(b.bodyFile)) - Number(Boolean(a.bodyFile)));
        }
        await writeJSON(path.join(runDirectory(run.runId), 'run.json'), run);
        print({ runId: run.runId });
      } else run = await readJSON(path.join(runDirectory(values.run), 'run.json'));
      if (command === 'reparse') run.verifiedVariants = await readJSON(path.join(local, 'verified-variants.json'), run.verifiedVariants ?? []);
      if (command === 'export') print(await exportRun(run, path.join(root, 'data'), { partial: Boolean(values.partial) }));
      else {
      const report = await processRun(run, runDirectory(run.runId), gate, {
        reparse: command === 'reparse', cancelled: () => cancelled, progress: print
      });
        print(report); if (!report.complete) process.exitCode = 2;
      }
    } else throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, exitCode: typeof error.code === 'number' ? error.code : 1 }));
  process.exitCode = typeof error.code === 'number' ? error.code : 1;
} finally { if (release) await release(); }
