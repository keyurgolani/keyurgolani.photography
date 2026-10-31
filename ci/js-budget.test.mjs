// @vitest-environment node
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { jsBudget, LIMIT, ROUTES, routeJs } from './js-budget.mjs';

const gz = (text) => zlib.gzipSync(text, { level: 9 }).length;

/** A tree shaped like `next build`'s output: a build manifest, each route's client reference manifest, and its chunks. */
function tree({ main = 'main();', page = 'page();', extra = '', inline } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'js-budget-'));
  const next = path.join(root, '.next');
  fs.mkdirSync(path.join(next, 'static', 'chunks'), { recursive: true });
  const chunk = (name, body) => fs.writeFileSync(path.join(next, 'static', 'chunks', name), body);
  chunk('main.js', main);
  chunk('polyfills.js', 'x'.repeat(5000));
  chunk('layout.js', 'layout();');
  chunk('page.js', page + extra);
  chunk('og.js', 'y'.repeat(5000));
  fs.writeFileSync(path.join(next, 'build-manifest.json'), JSON.stringify({ polyfillFiles: ['static/chunks/polyfills.js'], rootMainFiles: ['static/chunks/main.js'] }));
  const manifest = {
    entryCSSFiles: {},
    entryJSFiles: {
      '[project]/app/opengraph-image--metadata': ['static/chunks/og.js'],
      '[project]/app/layout': ['static/chunks/layout.js'],
      '[project]/app/page': ['static/chunks/layout.js', 'static/chunks/page.js'],
    },
  };
  for (const route of Object.values(ROUTES)) {
    const file = path.join(next, 'server', 'app', `${route}_client-reference-manifest.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/${route}"] = ${JSON.stringify(manifest)};\n`);
  }
  if (inline !== undefined) {
    fs.mkdirSync(path.join(root, 'components', 'site'), { recursive: true });
    fs.writeFileSync(path.join(root, 'components', 'site', 'themeScript.ts'), `export const THEME_INIT_SCRIPT = ${JSON.stringify(inline)};\n`);
  }
  return root;
}

describe('js-budget', () => {
  it('sums the root main files and the route entries, each once, and leaves out polyfills and metadata', async () => {
    const result = await routeJs(tree(), 'page');
    expect(result).toEqual({ gzip: gz('main();') + gz('layout();') + gz('page();'), files: 3 });
  });

  it('counts the inline theme script where the tree has it', async () => {
    const result = await routeJs(tree({ inline: 'theme();' }), 'work/page');
    expect(result).toEqual({ gzip: gz('main();') + gz('layout();') + gz('page();') + gz('theme();'), files: 4 });
  });

  it('passes a head within +1,000 B on every route, and fails one past it by its overage', async () => {
    const base = tree();
    expect((await jsBudget(base, tree({ inline: 'theme();' }))).over).toBe(0);
    // Random bytes don't compress, so the page chunk grows by more than the budget.
    const noise = randomBytes(LIMIT * 2).toString('base64');
    const { rows, over } = await jsBudget(base, tree({ extra: noise }));
    expect(over).toBe(Object.keys(ROUTES).length);
    expect(rows[0]).toMatch(/^\| Home \| \d+ B \(3 files\) \| \d+ B \(3 files\) \| \+\d+ B \| over by \d+ B \|$/);
  });

  it('names a route with no build', async () => {
    await expect(routeJs(fs.mkdtempSync(path.join(os.tmpdir(), 'js-budget-')), 'page')).rejects.toThrow('No manifest for page');
  });
});
