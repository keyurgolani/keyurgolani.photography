// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DYNAMIC_PATHS, prerenderedPaths } from './check-prerender.mjs';

// A manifest in the shape `next build` writes, prerendering /about.
function manifest({ routes = {}, dynamicRoutes = {} } = {}) {
  return {
    version: 4,
    routes: { '/about': { initialRevalidateSeconds: false, srcRoute: '/about', dataRoute: '/about.rsc' }, ...routes },
    dynamicRoutes,
    notFoundRoutes: [],
    preview: {},
  };
}

// The entry a build wrote for /api/photos while the route set revalidate = 60.
const PHOTOS_AT_BUILD_TIME = {
  '/api/photos': { initialRevalidateSeconds: 60, initialExpireSeconds: 31536000, srcRoute: '/api/photos', dataRoute: null },
};

describe('prerenderedPaths', () => {
  it('lists Home and the catalog API routes', () => {
    expect(DYNAMIC_PATHS).toEqual(expect.arrayContaining(['/', '/api/photos', '/api/ready']));
  });

  it('lists Work and the legacy Gallery, whose cutover gate reads the catalog per request', () => {
    expect(DYNAMIC_PATHS).toEqual(expect.arrayContaining(['/work', '/gallery']));
  });

  it('finds Work and the Gallery when the build prerendered them as static pages', () => {
    const routes = {
      '/work': { initialRevalidateSeconds: false, srcRoute: '/work', dataRoute: '/work.rsc' },
      '/gallery': { initialRevalidateSeconds: false, srcRoute: '/gallery', dataRoute: '/gallery.rsc' },
    };
    expect(prerenderedPaths(manifest({ routes }))).toEqual(['/gallery', '/work']);
  });

  it('lists the series route by its pattern, since the page reads the catalog per request', () => {
    expect(DYNAMIC_PATHS).toContain('/work/[slug]');
  });

  it('finds the series route when the build prerendered a series page or kept its pattern', () => {
    const throughPath = manifest({ routes: { '/work/fixture-a': { initialRevalidateSeconds: false, srcRoute: '/work/[slug]', dataRoute: '/work/fixture-a.rsc' } } });
    expect(prerenderedPaths(throughPath)).toEqual(['/work/[slug]']);
    const asPattern = manifest({ dynamicRoutes: { '/work/[slug]': { routeRegex: '^/work/([^/]+?)(?:/)?$', fallback: null } } });
    expect(prerenderedPaths(asPattern)).toEqual(['/work/[slug]']);
  });

  it('lists the Viewer route by its pattern, since the page reads the catalog per request', () => {
    expect(DYNAMIC_PATHS).toContain('/work/[slug]/photo/[photoId]');
  });

  it('finds the Viewer route when the build prerendered a photo page or kept its pattern', () => {
    const route = '/work/[slug]/photo/[photoId]';
    const throughPath = manifest({ routes: { '/work/fixture-a/photo/ph_x': { initialRevalidateSeconds: false, srcRoute: route, dataRoute: '/work/fixture-a/photo/ph_x.rsc' } } });
    expect(prerenderedPaths(throughPath)).toEqual([route]);
    const asPattern = manifest({ dynamicRoutes: { [route]: { routeRegex: '^/work/([^/]+?)/photo/([^/]+?)(?:/)?$', fallback: null } } });
    expect(prerenderedPaths(asPattern)).toEqual([route]);
  });

  it('finds nothing when the build prerendered only other paths', () => {
    expect(prerenderedPaths(manifest())).toEqual([]);
  });

  it('finds a listed route the build prerendered', () => {
    expect(prerenderedPaths(manifest({ routes: PHOTOS_AT_BUILD_TIME }))).toEqual(['/api/photos']);
  });

  it('finds Home when the build prerendered it', () => {
    const home = { '/': { initialRevalidateSeconds: false, srcRoute: '/', dataRoute: '/index.rsc' } };
    expect(prerenderedPaths(manifest({ routes: home }))).toEqual(['/']);
  });

  it('finds a dynamic route by its pattern, through a path it prerendered or as a dynamic route', () => {
    const paths = ['/work/[slug]'];
    const throughPath = manifest({ routes: { '/work/landscapes': { srcRoute: '/work/[slug]', dataRoute: '/work/landscapes.rsc' } } });
    expect(prerenderedPaths(throughPath, paths)).toEqual(['/work/[slug]']);
    const asPattern = manifest({ dynamicRoutes: { '/work/[slug]': { routeRegex: '^/work/([^/]+?)(?:/)?$', fallback: null } } });
    expect(prerenderedPaths(asPattern, paths)).toEqual(['/work/[slug]']);
  });

  it.each([
    ['no routes object', { version: 4, dynamicRoutes: {} }],
    ['no dynamicRoutes object', { version: 4, routes: {} }],
    ['routes as an array', { version: 4, routes: [], dynamicRoutes: {} }],
    ['an array', []],
  ])('refuses a manifest with %s', (_, broken) => {
    expect(() => prerenderedPaths(broken)).toThrow('Next changed its format');
  });
});

describe('check-prerender.mjs run directly', () => {
  const script = fileURLToPath(new URL('./check-prerender.mjs', import.meta.url));
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function file(contents) {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-prerender-'));
    dirs.push(dir);
    const target = path.join(dir, 'prerender-manifest.json');
    if (contents !== undefined) writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return target;
  }

  function run(target) {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, target], { encoding: 'utf8' }) };
    } catch (error) {
      return { status: error.status, stdout: error.stdout };
    }
  }

  it('exits 0 and names the paths it checked when the build prerendered none of them', () => {
    const result = run(file(manifest()));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The build prerendered none of: /, /api/photos, /api/ready, /work, /gallery, /work/[slug], /work/[slug]/photo/[photoId].');
  });

  it('exits 1 with the fix when the build prerendered /api/photos', () => {
    const result = run(file(manifest({ routes: PHOTOS_AT_BUILD_TIME })));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::The build prerendered /api/photos, which must render per request.');
    expect(result.stdout).toContain("Set dynamic = 'force-dynamic' on the route");
  });

  it('exits 1 and says to build first when there is no manifest', () => {
    const target = file();
    const result = run(target);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::There is no ${target}. Run npm run build first.`);
  });

  it.each([
    ['is not JSON', '{"routes":', 'it is not valid JSON.'],
    ['has changed format', { version: 5, pages: {} }, 'Next changed its format'],
  ])('exits 1 when the manifest %s', (_, contents, reason) => {
    const target = file(contents);
    const result = run(target);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::${target} can't be checked: `);
    expect(result.stdout).toContain(reason);
  });
});
