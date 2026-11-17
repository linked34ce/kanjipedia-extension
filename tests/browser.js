import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { buildExtension } from '../scripts/build.js';
import { root } from '../scripts/dictionary.js';
import { writeJSON } from '../collector/store.js';

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'kanjipedia-browser-'),
);
assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));

try {
  const htmlIndex = process.argv.indexOf('--html');
  const fixture = await fs.readFile(
    htmlIndex >= 0
      ? process.argv[htmlIndex + 1]
      : path.join(root, 'tests/fixtures/kanji.html'),
    'utf8',
  );
  const artifacts = path.join(root, 'artifacts');

  await fs.mkdir(artifacts, { recursive: true });

  const inputIndex = process.argv.indexOf('--input');
  let input =
    inputIndex >= 0
      ? process.argv[inputIndex + 1]
      : path.join(temporary, 'fixture.json');

  if (inputIndex < 0)
    await writeJSON(input, {
      schemaVersion: 1,
      entries: {
        白亜: [{ path: '/kotoba/0005614200', reading: 'ハクア' }],
        白亜紀: [{ path: '/kotoba/0000000001', reading: 'ハクアキ' }],
        東亜: [{ path: '/kotoba/0000000002', reading: 'チガウ' }],
        欧亜: [
          { path: '/kotoba/0000000003', reading: 'オウア' },
          { path: '/kotoba/0000000004', reading: 'オウア' },
        ],
      },
    });

  const extension = path.join(temporary, 'extension');
  const build = await buildExtension({ input, output: extension });
  const expectedIndex = process.argv.indexOf('--expected');
  // 受入例の正解を固定し、本番の候補選択の誤りを期待値へ持ち込まない。
  const expectedLinks =
    expectedIndex >= 0
      ? JSON.parse(await fs.readFile(process.argv[expectedIndex + 1], 'utf8'))
      : [
          {
            text: '白亜(ハクア)',
            href: 'https://www.kanjipedia.jp/kotoba/0005614200',
          },
        ];

  assert.ok(
    expectedLinks.some((item) => item.text === '白亜(ハクア)'),
    '受入検証には白亜の項目が必要',
  );

  const url = 'https://www.kanjipedia.jp/kanji/0000000500';

  async function check(enabled) {
    const context = await chromium.launchPersistentContext(
      path.join(temporary, enabled ? 'enabled' : 'baseline'),
      {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1000, height: 700 },
        args: [
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          ...(enabled
            ? [
                `--disable-extensions-except=${extension}`,
                `--load-extension=${extension}`,
              ]
            : ['--disable-extensions']),
        ],
      },
    );

    try {
      const requests = [],
        errors = [],
        contexts = [];

      await context.route('**/*', (route) => {
        requests.push(route.request().url());

        if (route.request().url() === url)
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: fixture,
          });

        if (
          route.request().url() ===
          'https://www.kanjipedia.jp/kotoba/0005614200'
        )
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<title>fixture destination</title>',
          });

        return route.abort();
      });

      const page = await context.newPage();

      page.on('pageerror', (error) => errors.push(error.message));

      const cdp = await context.newCDPSession(page);

      cdp.on('Runtime.executionContextCreated', (event) =>
        contexts.push(event.context),
      );
      cdp.on('Runtime.exceptionThrown', (event) =>
        errors.push(event.exceptionDetails.text),
      );
      await cdp.send('Runtime.enable');

      const start = performance.now();

      await page.goto(url);

      if (enabled)
        await page.locator('a[data-kanjipedia-link]').first().waitFor();

      const initializationMs = performance.now() - start;
      const state = await page.evaluate(() => ({
        text: document.getElementById('target').textContent,
        other: document.getElementById('other').outerHTML,
        links: [...document.querySelectorAll('a[data-kanjipedia-link]')].map(
          (a) => ({ text: a.textContent, href: a.href }),
        ),
        height: document.getElementById('target').getBoundingClientRect()
          .height,
        highlights: [
          ...document.querySelectorAll('#target a[data-kanjipedia-link]'),
        ].map((a) => getComputedStyle(a).backgroundColor),
      }));

      await page.screenshot({
        path: path.join(artifacts, enabled ? 'extension.png' : 'baseline.png'),
      });
      const initialRequests = [...requests];

      let metrics;

      if (enabled) {
        assert.deepEqual(state.links, expectedLinks);
        assert.deepEqual(
          state.highlights,
          expectedLinks.map(() => 'rgb(214, 233, 250)'),
        );

        const isolated = contexts.find((item) =>
          item.origin.startsWith('chrome-extension://'),
        );

        assert.ok(isolated, '拡張の分離実行環境が実際に読み込まれていること');

        metrics = (
          await cdp.send('Runtime.evaluate', {
            expression: 'globalThis.__KANJIPEDIA_METRICS__',
            contextId: isolated.id,
            returnByValue: true,
          })
        ).result.value;
        await cdp.send('Runtime.evaluate', {
          expression: await fs.readFile(
            path.join(extension, 'content.js'),
            'utf8',
          ),
          contextId: isolated.id,
        });

        assert.equal(
          await page.locator('a[data-kanjipedia-link]').count(),
          expectedLinks.length,
        );

        const repeated = (
          await cdp.send('Runtime.evaluate', {
            expression: 'globalThis.__KANJIPEDIA_METRICS__.count',
            contextId: isolated.id,
            returnByValue: true,
          })
        ).result.value;

        assert.equal(repeated, 0);

        const first = page.locator('a[data-kanjipedia-link]').first();

        await first.hover();

        assert.equal(
          await first.evaluate((a) => getComputedStyle(a).backgroundColor),
          'rgb(190, 218, 243)',
        );

        await page.mouse.move(999, 699);
        await page.keyboard.press('Tab');

        assert.equal(
          await page.evaluate(() => document.activeElement.textContent),
          expectedLinks[0].text,
        );
        assert.equal(
          await first.evaluate((a) => getComputedStyle(a).outlineStyle),
          'solid',
        );

        for (
          let i = 0;
          i < expectedLinks.findIndex((item) => item.text === '白亜(ハクア)');
          i++
        )
          await page.keyboard.press('Tab');

        const pageCount = context.pages().length;

        await Promise.all([
          page.waitForURL('**/kotoba/0005614200'),
          page.keyboard.press('Enter'),
        ]);
        assert.equal(
          context.pages().length,
          pageCount,
          'Enterで別タブを開かない',
        );
      }

      assert.deepEqual(errors, []);

      return {
        requests: initialRequests,
        errors,
        state,
        initializationMs,
        metrics,
      };
    } finally {
      await context.close();
    }
  }

  const baseline = await check(false),
    enabled = await check(true);

  assert.equal(enabled.state.text, baseline.state.text);
  assert.equal(enabled.state.other, baseline.state.other);
  assert.equal(enabled.state.height, baseline.state.height);
  assert.deepEqual(enabled.requests, baseline.requests);

  const report = {
    browser: chromium.executablePath(),
    build,
    baseline,
    enabled,
    addedHTTP: enabled.requests.length - baseline.requests.length,
    fixture:
      htmlIndex >= 0
        ? 'local evidence fragment; network blocked'
        : 'synthetic; network blocked',
    manualLiveCheck: false,
  };

  await writeJSON(path.join(artifacts, 'browser-report.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
