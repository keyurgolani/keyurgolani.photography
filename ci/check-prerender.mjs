// Fails when `next build` prerendered a route that has to render per request.
//
// Routes that read the catalog set `dynamic = 'force-dynamic'`, since a
// build-time render would keep serving the data root as it was at build time.
// Run this after `npm run build`. It reads .next/prerender-manifest.json, or
// the file given as its argument, and exits 1 if the build prerendered one of
// DYNAMIC_PATHS.
//
//   npm run check:prerender
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Paths no build may prerender. A route that reads the catalog adds its path,
// and a dynamic one its pattern, such as /work/[slug].
export const DYNAMIC_PATHS = ['/', '/api/photos', '/api/ready'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The paths in `paths` that `manifest`, a parsed prerender-manifest.json,
// prerenders: as a route, as the source route of one, or as a dynamic route.
// A manifest without its routes and dynamicRoutes objects throws, so a change
// in Next's format fails the check instead of passing it.
export function prerenderedPaths(manifest, paths = DYNAMIC_PATHS) {
  if (!isObject(manifest) || !isObject(manifest.routes) || !isObject(manifest.dynamicRoutes)) {
    throw new Error('it has no routes or dynamicRoutes object, so Next changed its format. Update ci/check-prerender.mjs to read it.');
  }
  const listed = new Set(paths);
  const found = new Set();
  for (const [route, entry] of Object.entries(manifest.routes)) {
    if (listed.has(route)) found.add(route);
    if (isObject(entry) && listed.has(entry.srcRoute)) found.add(entry.srcRoute);
  }
  for (const route of Object.keys(manifest.dynamicRoutes)) {
    if (listed.has(route)) found.add(route);
  }
  return [...found].sort();
}

function main() {
  const file = process.argv[2] ?? fileURLToPath(new URL('../.next/prerender-manifest.json', import.meta.url));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? `There is no ${file}. Run npm run build first.` : `Could not read ${file}: ${error.message}`);
  }
  let found;
  try {
    found = prerenderedPaths(JSON.parse(text));
  } catch (error) {
    throw new Error(`${file} can't be checked: ${error instanceof SyntaxError ? 'it is not valid JSON.' : error.message}`);
  }
  if (found.length > 0) {
    throw new Error(
      `The build prerendered ${found.join(', ')}, which must render per request. ` +
        "Set dynamic = 'force-dynamic' on the route, and drop any revalidate, unstable_cache, or 'use cache' it uses.",
    );
  }
  console.log(`The build prerendered none of: ${DYNAMIC_PATHS.join(', ')}.`);
}

function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
