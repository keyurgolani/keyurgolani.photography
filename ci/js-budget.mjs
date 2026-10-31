#!/usr/bin/env node
/**
 * The themes' JS budget (the themes scope, item 7): each visitor route's first-load JS, gzipped, may grow at most
 * 3,000 bytes over v1.2.0's (the lead's ruling after perf5: it pays for the inline theme script and the theme control). Measured as ci/themes-budget.mjs measures CSS, from the production build with no server:
 * the root main files every page loads (build-manifest.json's rootMainFiles) and the route's entry chunks (its client
 * reference manifest's entryJSFiles, leaving out metadata routes), each file gzipped at level 9 and summed. The
 * polyfills are left out, since they load only in browsers without modules. An inline script every page renders
 * counts too, gzipped on its own: INLINE lists them by hand, so a new one has to be added there, or it goes uncounted.
 * The perf run (run-perf5.sh) runs it against v1.2.0's build; it exits 1 past the budget.
 *
 *   node ci/js-budget.mjs <base tree> <head tree>
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const LIMIT = 3000;
/** Inline scripts every page renders, by the module and export that hold them, read from each tree's source. */
export const INLINE = [['components/site/themeScript.ts', 'THEME_INIT_SCRIPT']];
export const ROUTES = {
  Home: 'page',
  'A series': 'work/[slug]/page',
  'The Viewer, cold': 'work/[slug]/photo/[photoId]/page',
  Work: 'work/page',
  About: 'about/page',
  'The 404': '_not-found/page',
};
/**
 * Reported, not gated: the error page as shown on a route, which is that route's first load plus the chunks the
 * error boundary's entry imports lazily when it renders (app/error.tsx's nav), found as chunk paths in its files.
 */
export const SHOWN = { 'The error page, shown on Work': 'work/page' };

/** The route's first-load scripts, from the build manifest and its client reference manifest, plus the inline ones, gzipped. */
export async function routeJs(tree, route) {
  const root = path.join(tree, '.next');
  const file = path.join(root, 'server', 'app', `${route}_client-reference-manifest.js`);
  if (!fs.existsSync(file)) throw new Error(`No manifest for ${route} in ${tree}. Build it first.`);
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8'));
  const scope = {};
  new Function('globalThis', fs.readFileSync(file, 'utf8'))(scope);
  const manifest = Object.values(scope.__RSC_MANIFEST)[0];
  const files = new Set(build.rootMainFiles ?? []);
  for (const [entry, list] of Object.entries(manifest.entryJSFiles ?? {})) {
    if (entry.includes('metadata')) continue;
    for (const item of list) files.add(typeof item === 'string' ? item : item.path);
  }
  let gzip = 0;
  for (const js of files) gzip += zlib.gzipSync(fs.readFileSync(path.join(root, js)), { level: 9 }).length;
  let count = files.size;
  for (const [module, exported] of INLINE) {
    if (!fs.existsSync(path.join(tree, module))) continue;
    const script = (await import(pathToFileURL(path.resolve(tree, module)).href))[exported];
    gzip += zlib.gzipSync(script, { level: 9 }).length;
    count++;
  }
  return { gzip, files: count };
}

/** The route's first load plus the chunks its error entry loads when it shows, gzipped. */
export async function errorShownJs(tree, route) {
  const root = path.join(tree, '.next');
  const first = await routeJs(tree, route);
  const scope = {};
  new Function('globalThis', fs.readFileSync(path.join(root, 'server', 'app', `${route}_client-reference-manifest.js`), 'utf8'))(scope);
  const manifest = Object.values(scope.__RSC_MANIFEST)[0];
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8'));
  const loaded = new Set(build.rootMainFiles ?? []);
  for (const [entry, list] of Object.entries(manifest.entryJSFiles ?? {})) if (!entry.includes('metadata')) for (const item of list) loaded.add(typeof item === 'string' ? item : item.path);
  const lazy = new Set();
  for (const item of manifest.entryJSFiles?.['[project]/app/error'] ?? []) {
    const text = fs.readFileSync(path.join(root, typeof item === 'string' ? item : item.path), 'utf8');
    for (const [chunk] of text.matchAll(/static\/chunks\/[A-Za-z0-9_-]+\.js/g)) if (!loaded.has(chunk) && fs.existsSync(path.join(root, chunk))) lazy.add(chunk);
  }
  let gzip = first.gzip;
  for (const chunk of lazy) gzip += zlib.gzipSync(fs.readFileSync(path.join(root, chunk)), { level: 9 }).length;
  return { gzip, files: first.files + lazy.size };
}

/** The table's rows and how many routes are over. */
export async function jsBudget(base, head) {
  const rows = [];
  let over = 0;
  for (const [name, route] of Object.entries(ROUTES)) {
    const [before, after] = [await routeJs(base, route), await routeJs(head, route)];
    const change = after.gzip - before.gzip;
    const ok = change <= LIMIT;
    if (!ok) over++;
    rows.push(`| ${name} | ${before.gzip} B (${before.files} files) | ${after.gzip} B (${after.files} files) | ${change >= 0 ? '+' : ''}${change} B | ${ok ? 'within' : `over by ${change - LIMIT} B`} |`);
  }
  for (const [name, route] of Object.entries(SHOWN)) {
    const [before, after] = [await errorShownJs(base, route), await errorShownJs(head, route)];
    const change = after.gzip - before.gzip;
    rows.push(`| ${name} (reported, not gated) | ${before.gzip} B (${before.files} files) | ${after.gzip} B (${after.files} files) | ${change >= 0 ? '+' : ''}${change} B | ${change <= LIMIT ? 'within' : `over by ${change - LIMIT} B`} |`);
  }
  return { rows, over };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('Usage: node ci/js-budget.mjs <base tree> <head tree>');
    process.exit(2);
  }
  const { rows, over } = await jsBudget(base, head);
  console.log(`| Route | v1.2.0 JS | Head JS | Change | Budget (+${LIMIT} B) |\n|---|---|---|---|---|\n${rows.join('\n')}`);
  if (over) {
    console.error(`\n${over} route${over === 1 ? '' : 's'} past the +${LIMIT} B gzipped budget.`);
    process.exit(1);
  }
}
