#!/usr/bin/env node
/**
 * The themes' CSS budget (R2-P2-1): each visitor route's first-load CSS, gzipped, may grow at most 2,500 bytes over
 * the base build's (next before the themes). First-load CSS is every stylesheet a cold load of the route links, read
 * from the production build's client reference manifests, so it needs no server: each file gzipped at level 9, and
 * summed. A route's own inline stylesheet (About's theme blocks, which ride in its HTML so they stay off every other
 * route) counts too, gzipped on its own. INLINE lists them by hand: a new route-scoped inline stylesheet has to be
 * added there, or it goes uncounted. CI's Themes job builds both trees and runs it; it exits 1 past the budget.
 *
 *   node ci/themes-budget.mjs <base tree> <head tree>
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const LIMIT = 2500;
/** Inline stylesheets a route renders, by the module and export that hold them, read from each tree's source. */
const INLINE = {
  About: ['app/about/aboutThemes.ts', 'ABOUT_THEMES_CSS'],
  // The Viewer's theme tokens (#126), in a directly loaded Viewer's HTML. A series opens the modal Viewer on the client,
  // which inserts them then, so they aren't on a series' first load.
  'The Viewer, cold': ['components/viewer/viewerThemes.ts', 'VIEWER_THEMES_CSS'],
};
const ROUTES = {
  Home: 'page',
  'A series': 'work/[slug]/page',
  'The Viewer, cold': 'work/[slug]/photo/[photoId]/page',
  Work: 'work/page',
  About: 'about/page',
};

/** The route's first-load stylesheets, from its client reference manifest, plus its inline one, gzipped. */
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
  let gzip = 0;
  for (const css of files) gzip += zlib.gzipSync(fs.readFileSync(path.join(root, css)), { level: 9 }).length;
  let count = files.size;
  const [module, exported] = INLINE[name] ?? [];
  if (module && fs.existsSync(path.join(tree, module))) {
    const css = (await import(pathToFileURL(path.resolve(tree, module)).href))[exported];
    gzip += zlib.gzipSync(css, { level: 9 }).length;
    count++;
  }
  return { gzip, files: count };
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: node ci/themes-budget.mjs <base tree> <head tree>');
  process.exit(2);
}
let over = 0;
console.log(`| Route | Base | Head | Change | Budget |\n|---|---|---|---|---|`);
for (const [name, route] of Object.entries(ROUTES)) {
  const [before, after] = [await routeCss(base, route, name), await routeCss(head, route, name)];
  const change = after.gzip - before.gzip;
  const ok = change <= LIMIT;
  if (!ok) over++;
  console.log(`| ${name} | ${before.gzip} B (${before.files} files) | ${after.gzip} B (${after.files} files) | ${change >= 0 ? '+' : ''}${change} B | ${ok ? 'within' : `over by ${change - LIMIT} B`} |`);
}
if (over) {
  console.error(`\n${over} route${over === 1 ? '' : 's'} past the +${LIMIT} B gzipped budget.`);
  process.exit(1);
}
