#!/usr/bin/env node
// @ts-check
/**
 * The A/B perf job's driver (.github/workflows/perf-ab.yml). Runs from the workflow's own checkout, so base and head
 * are measured by the same code whatever refs they are.
 *
 *   node ci/perf/ab.mjs build <tree>...
 *   node ci/perf/ab.mjs measure --base <tree> --head <tree> --rounds <n> --out <dir> [--loads 3] [--base-ref <name>] [--head-ref <name>]
 *
 * `build` runs `npm run build` in each tree under the Playwright servers' env, as e2e/themes/build.ts does.
 *
 * `measure`, for each fixture, `one` (Home's one featured series) and `variety` (three featured series in a loop):
 * 1. Publishes the fixture three times, under os.tmpdir(), each by its own tree's e2e/support/publish-home-fixture.ts
 *    (lib/catalog/testing.ts createTestCatalog), so each build reads a catalog its own code wrote. Base's two copies
 *    go to A1 and A2, head's to B. Each gets a stand-in About portrait from its tree's write-site-config.ts and an
 *    empty photo library.
 * 2. Starts `next start` on 127.0.0.1 for each, A1 on 3871, B on 3872, A2 on 3873, waits for /api/ready, and refuses
 *    to go on unless `ss` shows each port listening on 127.0.0.1 only. Warms each: Home and every image it names, six
 *    times.
 * 3. Runs `--rounds` rounds in stats.mjs's roundOrder(), each server `--loads` cold loads of Home per profile
 *    (measure.mjs), in system Chrome from the runner image, so nothing is downloaded.
 * 4. Stops the servers.
 * Then reads each build's first-load JS from its manifests, and writes everything to `<out>/raw.json`, with each
 * server's log beside it. report.mjs turns that into the table and the verdict.
 *
 * Nothing leaves 127.0.0.1: the browser aborts any other request, the servers bind loopback, and Next's telemetry is
 * off. It never reads a real data root or library: the PHOTOGRAPHY_, CURATION_ and CURATOR_ settings and SITE_URL are
 * dropped from every child's env, and each root is a fresh temp folder. The temp folders are left for the runner to
 * throw away.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { measureLoad, PROFILES } from './measure.mjs';
import { loopbackListeners, parseRounds, roundOrder, SERVERS } from './stats.mjs';

/** @typedef {import('./stats.mjs').Server} Server */

const FIXTURES = /** @type {const} */ ({ one: [], variety: ['--variety'] });
/** @type {Record<Server, number>} */
const PORTS = { A1: 3871, B: 3872, A2: 3873 };
const READY_MS = 120_000;
const WARM_PASSES = 6;
/** Each visitor route's server manifest, as ci/themes-budget.mjs reads them, and the preview's Home. */
const JS_ROUTES = { Home: 'page', 'A series': 'work/[slug]/page', 'The Viewer, cold': 'work/[slug]/photo/[photoId]/page', Work: 'work/page', About: 'about/page', 'Preview Home': 'curation/preview/[draftId]/site/page' };

/** The settings that turn a server into the curator, or point it at another root. Never inherited. */
const DROPPED = /^(PHOTOGRAPHY_|CURATION_|CURATOR_)|^SITE_URL$/;
/** @param {Record<string, string>} extra @returns {NodeJS.ProcessEnv} */
const childEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.test(name))), NEXT_TELEMETRY_DISABLED: '1', ...extra });

/** @param {string} message */
const log = (message) => console.log(`[perf-ab ${new Date().toISOString().slice(11, 19)}] ${message}`);

/** @param {string} tree @param {string[]} args @param {NodeJS.ProcessEnv} env */
function runIn(tree, args, env) {
  const [command, ...rest] = args;
  const result = spawnSync(command, rest, { cwd: tree, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed in ${tree} (${result.status ?? result.signal}).`);
}

/** @param {string[]} trees */
function build(trees) {
  if (trees.length === 0) throw new Error('Usage: ab.mjs build <tree>...');
  for (const tree of trees) {
    log(`Building ${tree}`);
    runIn(path.resolve(tree), ['npm', 'run', 'build'], childEnv({ ALLOW_PROVISIONAL_COPY: '1' }));
  }
}

/** @param {string[]} argv */
function options(argv) {
  /** @type {Record<string, string>} */
  const found = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith('--') || argv[at + 1] === undefined) throw new Error(`Unexpected argument ${argv[at]}.`);
    found[argv[at].slice(2)] = argv[at + 1];
  }
  for (const name of ['base', 'head', 'rounds', 'out']) if (!found[name]) throw new Error(`measure needs --${name}.`);
  const loads = Number(found.loads ?? '3');
  if (!Number.isInteger(loads) || loads < 1) throw new Error(`--loads must be a whole number, at least 1, got ${found.loads}.`);
  return { base: path.resolve(found.base), head: path.resolve(found.head), rounds: parseRounds(found.rounds), loads, out: path.resolve(found.out), baseRef: found['base-ref'] ?? 'base', headRef: found['head-ref'] ?? 'head' };
}

/** @param {string} tree */
const shaOf = (tree) => spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';

/** @param {number} port */
function listeners(port) {
  return loopbackListeners(spawnSync('ss', ['-Hltn', `sport = :${port}`], { encoding: 'utf8' }).stdout ?? '', port);
}

/**
 * `next start` from `tree` on 127.0.0.1:`port`, on `root`, its output to `logFile`.
 * @param {string} tree @param {number} port @param {string} root @param {string} logFile
 */
async function serve(tree, port, root, logFile) {
  // The last fixture's server on this port may take a moment to let go of it.
  for (let wait = 0; listeners(port).addresses.length > 0; wait++) {
    if (wait === 20) throw new Error(`Port ${port} is taken.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: tree,
    env: childEnv({ NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', PHOTOGRAPHY_DATA_DIR: path.join(root, 'data'), PHOTOGRAPHY_LIBRARY_DIR: path.join(root, 'library'), PHOTOGRAPHY_SITE_CONFIG_DIR: path.join(root, 'site-config') }),
    detached: true,
    stdio: ['ignore', out, out],
  });
  /** @param {NodeJS.Signals} signal */
  const kill = (signal) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // Gone already.
    }
  };
  process.once('exit', () => kill('SIGKILL'));
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
      const force = setTimeout(() => kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve(undefined);
      });
      kill('SIGTERM');
    });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server on ${port} exited with ${child.exitCode}. See ${logFile}.`);
    if ((await fetch(`${origin}/api/ready`).then((response) => response.status, () => 0)) === 200) {
      const bound = listeners(port);
      if (!bound.ok) {
        await stop();
        throw new Error(`The server on ${port} isn't on 127.0.0.1 only: ${bound.addresses.join(', ') || 'no listener'}.`);
      }
      return { origin, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
  throw new Error(`The server on ${port} never answered /api/ready. See ${logFile}.`);
}

const IMAGE_URLS = /(\/about\/portrait\/[0-9a-f]{32}\/w[0-9]+\.(avif|webp))|(\/media\/[^" ,]+\.(avif|webp))/g;

/** Home and every image it names, several times, so each featured series' opening is warm. @param {string} origin */
async function warm(origin) {
  for (let pass = 0; pass < WARM_PASSES; pass++) {
    const html = await fetch(`${origin}/`).then((response) => response.text());
    const urls = new Set([...html.matchAll(IMAGE_URLS)].map((match) => match[0].replaceAll('&amp;', '&')));
    for (const url of urls) await fetch(`${origin}${url}`).then((response) => response.arrayBuffer());
  }
}

/** Publishes `fixture` by `tree` into `root`, with a stand-in site config and an empty library. @param {string} tree @param {string} root @param {readonly string[]} flags */
function prepare(tree, root, flags) {
  const tsx = path.join(tree, 'node_modules', '.bin', 'tsx');
  fs.mkdirSync(path.join(root, 'library'), { recursive: true });
  // write-site-config.ts resolves the folder before it writes into it, so it must exist first.
  fs.mkdirSync(path.join(root, 'site-config'), { recursive: true });
  runIn(tree, [tsx, 'e2e/support/write-site-config.ts', path.join(root, 'site-config')], childEnv());
  runIn(tree, [tsx, 'e2e/support/publish-home-fixture.ts', path.join(root, 'data'), ...flags], childEnv());
}

/** Each route's first-load JS, gzipped at level 9: rootMainFiles plus the route's entryJSFiles, metadata left out. @param {string} tree */
function firstLoadJs(tree) {
  const root = path.join(tree, '.next');
  const main = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8')).rootMainFiles;
  return Object.entries(JS_ROUTES).map(([name, route]) => {
    const file = path.join(root, 'server', 'app', `${route}_client-reference-manifest.js`);
    if (!fs.existsSync(file)) return { name, gzip: null, raw: null, files: null };
    /** @type {{ __RSC_MANIFEST?: Record<string, { entryJSFiles: Record<string, string[]> }> }} */
    const scope = {};
    new Function('globalThis', fs.readFileSync(file, 'utf8'))(scope);
    const manifest = Object.values(scope.__RSC_MANIFEST ?? {})[0];
    const files = new Set(/** @type {string[]} */ (main));
    for (const [entry, list] of Object.entries(manifest?.entryJSFiles ?? {})) if (!entry.includes('metadata')) for (const item of list) files.add(item);
    let gzip = 0;
    let raw = 0;
    for (const item of files) {
      const bytes = fs.readFileSync(path.join(root, item));
      raw += bytes.length;
      gzip += zlib.gzipSync(bytes, { level: 9 }).length;
    }
    return { name, gzip, raw, files: files.size };
  });
}

/** @param {string[]} argv */
async function measure(argv) {
  const opts = options(argv);
  fs.mkdirSync(opts.out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-'));
  for (const tree of [opts.base, opts.head]) if (`${path.resolve(work)}${path.sep}`.startsWith(`${tree}${path.sep}`)) throw new Error(`The temp folder ${work} is inside ${tree}.`);
  // Both servers are measured by one browser: system Chrome, through the head's Playwright.
  const { chromium } = createRequire(path.join(opts.head, 'package.json'))('@playwright/test');
  /** @type {import('@playwright/test').Browser} */
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const raw = {
    meta: { base: { ref: opts.baseRef, sha: shaOf(opts.base) }, head: { ref: opts.headRef, sha: shaOf(opts.head) }, rounds: opts.rounds, loads: opts.loads, browser: `Chrome ${browser.version()}`, runner: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : os.platform(), startedAt: new Date().toISOString() },
    /** @type {Record<string, { rounds: import('./stats.mjs').Round[] }>} */
    fixtures: {},
    /** @type {{ base: import('./stats.mjs').RouteJs[], head: import('./stats.mjs').RouteJs[] } | undefined} */
    firstLoadJs: undefined,
  };
  const write = (name = 'raw.json') => fs.writeFileSync(path.join(opts.out, name), `${JSON.stringify(raw, null, 1)}\n`);
  try {
    for (const [fixture, flags] of Object.entries(FIXTURES)) {
      /** @type {Partial<Record<Server, { origin: string, stop: () => Promise<unknown> }>>} */
      const servers = {};
      try {
        for (const server of SERVERS) {
          const tree = server === 'B' ? opts.head : opts.base;
          const root = path.join(work, fixture, server);
          log(`${fixture}: publishing ${server} from ${tree}`);
          prepare(tree, root, flags);
          servers[server] = await serve(tree, PORTS[server], root, path.join(opts.out, `server-${fixture}-${server}.log`));
          log(`${fixture}: ${server} ready on ${PORTS[server]}`);
        }
        for (const server of SERVERS) await warm(/** @type {{ origin: string }} */ (servers[server]).origin);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const rounds = (raw.fixtures[fixture] = { rounds: /** @type {import('./stats.mjs').Round[]} */ ([]) }).rounds;
        for (let round = 0; round < opts.rounds; round++) {
          const order = roundOrder(round);
          /** @type {import('./stats.mjs').Round} */
          const record = { round, order, servers: {} };
          rounds.push(record);
          for (const server of order) {
            /** @type {Record<string, import('./stats.mjs').Load[]>} */
            const byProfile = {};
            for (const [name, profile] of Object.entries(PROFILES)) {
              byProfile[name] = [];
              for (let load = 0; load < opts.loads; load++) byProfile[name].push(await measureLoad(browser, `${/** @type {{ origin: string }} */ (servers[server]).origin}/`, profile));
            }
            record.servers[server] = byProfile;
            const lcps = Object.entries(byProfile).map(([name, loads]) => `${name} LCP ${loads.map((load) => load.lcp).join('/')} TBT ${loads.map((load) => load.tbt).join('/')}`);
            log(`${fixture} round ${round + 1}/${opts.rounds} ${server}: ${lcps.join(', ')}`);
          }
        }
      } finally {
        for (const server of SERVERS) await servers[server]?.stop();
      }
    }
    raw.firstLoadJs = { base: firstLoadJs(opts.base), head: firstLoadJs(opts.head) };
    write();
    log(`Wrote ${path.join(opts.out, 'raw.json')}`);
  } catch (error) {
    write('raw.partial.json');
    throw error;
  } finally {
    await browser.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'build') build(rest);
  else if (command === 'measure') await measure(rest);
  else throw new Error('Usage: ab.mjs build <tree>... | ab.mjs measure --base <tree> --head <tree> --rounds <n> --out <dir>');
} catch (error) {
  console.error(`[perf-ab] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
