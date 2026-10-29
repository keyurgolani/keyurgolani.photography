#!/usr/bin/env node
/**
 * The themes' CSS budget (R2-P2-1): each visitor route's first-load CSS, gzipped, may grow at most 2,500 bytes over
 * the base build's (next before the themes). First-load CSS is every stylesheet a cold load of the route links, read
 * from the production build's client reference manifests, so it needs no server: each file gzipped at level 9, and
 * summed. CI's Themes job builds both trees and runs it; it exits 1 past the budget.
 *
 *   node ci/themes-budget.mjs <base tree> <head tree>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LIMIT = 2500;
const ROUTES = {
  Home: 'page',
  'A series': 'work/[slug]/page',
  'The Viewer, cold': 'work/[slug]/photo/[photoId]/page',
  Work: 'work/page',
  About: 'about/page',
};

/** The route's first-load stylesheets, from its client reference manifest, and their gzipped sizes. */
function routeCss(tree, route) {
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
  return { gzip, files: files.size };
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: node ci/themes-budget.mjs <base tree> <head tree>');
  process.exit(2);
}
let over = 0;
console.log(`| Route | Base | Head | Change | Budget |\n|---|---|---|---|---|`);
for (const [name, route] of Object.entries(ROUTES)) {
  const [before, after] = [routeCss(base, route), routeCss(head, route)];
  const change = after.gzip - before.gzip;
  const ok = change <= LIMIT;
  if (!ok) over++;
  console.log(`| ${name} | ${before.gzip} B (${before.files} files) | ${after.gzip} B (${after.files} files) | ${change >= 0 ? '+' : ''}${change} B | ${ok ? 'within' : `over by ${change - LIMIT} B`} |`);
}
if (over) {
  console.error(`\n${over} route${over === 1 ? '' : 's'} past the +${LIMIT} B gzipped budget.`);
  process.exit(1);
}
