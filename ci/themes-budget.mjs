#!/usr/bin/env node
/**
 * The themes' CSS budget (R2-P2-1): each visitor route's first-load CSS, gzipped, may grow at most 2,500 bytes over
 * the base build's (next before the themes). First-load CSS is every stylesheet a cold load of the route links, read
 * from the production build's client reference manifests, so it needs no server: each file gzipped at level 9, and
 * summed. A route's own inline stylesheet (About's theme blocks, which ride in its HTML so they stay off every other
 * route) counts too, gzipped on its own. INLINE lists them by hand: a new route-scoped inline stylesheet has to be
 * added there, or it goes uncounted. CI's Themes job builds both trees and runs it; it exits 1 past the budget.
 *
 * Then, on the head alone, the curator CSS guard (curator-css.mjs): no visitor route's first-load CSS, the same
 * stylesheets the budget sums, may carry a module from app/curation/. It exits 1 naming the route and the module.
 *
 *   node ci/themes-budget.mjs <base tree> <head tree>
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { curatorCssFindings, curatorSheets, readBuildClasses } from './curator-css.mjs';

const LIMIT = 2500;
/** Inline stylesheets a route renders, by the module and export that hold them, read from each tree's source. */
const INLINE = { About: ['app/about/aboutThemes.ts', 'ABOUT_THEMES_CSS'] };
const ROUTES = {
  Home: 'page',
  'A series': 'work/[slug]/page',
  'The Viewer, cold': 'work/[slug]/photo/[photoId]/page',
  Work: 'work/page',
  About: 'about/page',
};

/** The route's first-load stylesheets, from its client reference manifest, plus its inline one, gzipped, and their text. */
async function routeCss(tree, route, name) {
  const root = path.join(tree, '.next');
  const file = path.join(root, 'server', 'app', `${route}_client-reference-manifest.js`);
  if (!fs.existsSync(file)) throw new Error(`No manifest for ${route} in ${tree}. Build it first.`);
  const scope = {};
  new Function('globalThis', fs.readFileSync(file, 'utf8'))(scope);
  const manifest = Object.values(scope.__RSC_MANIFEST)[0];
  const files = new Set();
  for (const [entry, list] of Object.entries(manifest.entryCSSFiles)) {
    if (entry.includes('metadata')) continue;
    for (const item of list) files.add(typeof item === 'string' ? item : item.path);
  }
  const sheets = [...files].map((file) => ({ file, css: fs.readFileSync(path.join(root, file), 'utf8') }));
  const [module, exported] = INLINE[name] ?? [];
  if (module && fs.existsSync(path.join(tree, module))) {
    sheets.push({ file: `${module} (${exported}, inline)`, css: (await import(pathToFileURL(path.resolve(tree, module)).href))[exported] });
  }
  let gzip = 0;
  for (const { css } of sheets) gzip += zlib.gzipSync(css, { level: 9 }).length;
  return { gzip, files: sheets.length, sheets };
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: node ci/themes-budget.mjs <base tree> <head tree>');
  process.exit(2);
}
let over = 0;
const heads = [];
console.log(`| Route | Base | Head | Change | Budget |\n|---|---|---|---|---|`);
for (const [name, route] of Object.entries(ROUTES)) {
  const [before, after] = [await routeCss(base, route, name), await routeCss(head, route, name)];
  heads.push({ name, sheets: after.sheets });
  const change = after.gzip - before.gzip;
  const ok = change <= LIMIT;
  if (!ok) over++;
  console.log(`| ${name} | ${before.gzip} B (${before.files} files) | ${after.gzip} B (${after.files} files) | ${change >= 0 ? '+' : ''}${change} B | ${ok ? 'within' : `over by ${change - LIMIT} B`} |`);
}
const curator = curatorCssFindings({ routes: heads, classes: readBuildClasses(path.join(head, '.next')), sources: curatorSheets(head) });
console.log(`\nCurator CSS on visitor routes: ${curator.length ? `${curator.length} found` : 'none'}.`);
for (const line of curator) console.error(line);
if (over) console.error(`\n${over} route${over === 1 ? '' : 's'} past the +${LIMIT} B gzipped budget.`);
if (over || curator.length) process.exit(1);
