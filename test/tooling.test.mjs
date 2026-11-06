// @vitest-environment node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Criterion 11 of #1: `npm test -- --run` collects no file under e2e/, and
// `npm run lint` rejects click handlers on non-interactive elements. Plain
// JavaScript, since ESLint 9.9 ships no types.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('npm run lint', () => {
  /** The rules `eslint.config.js` fails `code` on, as if it sat in components/. */
  async function lintErrors(code) {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, 'components', 'LintProbe.tsx') });
    return result.messages.filter((message) => message.severity === 2).map((message) => message.ruleId);
  }

  it('rejects a click handler on a div, and takes one on a button', async () => {
    expect(await lintErrors('export const Probe = () => <div onClick={() => {}}>Open</div>;\n')).toEqual(
      expect.arrayContaining(['jsx-a11y/click-events-have-key-events', 'jsx-a11y/no-static-element-interactions']),
    );
    expect(await lintErrors('export const Probe = () => <button type="button" onClick={() => {}}>Open</button>;\n')).toEqual([]);
  }, 30_000);
});

describe('npm test', () => {
  it('collects no file under e2e/', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitest-list-'));
    try {
      const listing = path.join(dir, 'files.json');
      // Through the CLI, so it collects the way `npm test` does.
      const cli = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
      await promisify(execFile)(process.execPath, [cli, 'list', '--filesOnly', `--json=${listing}`], { cwd: REPO_ROOT });
      const files = JSON.parse(await fs.readFile(listing, 'utf8')).map(({ file }) => path.relative(REPO_ROOT, file));
      expect(files).toContain(path.join('test', 'tooling.test.mjs'));
      expect(files.filter((file) => file.split(path.sep)[0] === 'e2e')).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('local servers', () => {
  // `npm run dev`, `npm start` and the e2e server listen on loopback, and the
  // dev and production compose files and the image smoke test publish their
  // ports to loopback only.
  it('stay on 127.0.0.1', async () => {
    const { scripts } = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(scripts.dev).toMatch(/--hostname 127\.0\.0\.1(\s|$)/);
    expect(scripts.start).toMatch(/--hostname 127\.0\.0\.1(\s|$)/);

    const compose = await fs.readFile(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const published = [...compose.matchAll(/^\s*-\s*"([\d.:]+)"\s*$/gm)].map(([, entry]) => entry);
    expect(published.length).toBeGreaterThan(0);
    for (const entry of published) expect(entry).toMatch(/^127\.0\.0\.1:/);

    const config = await fs.readFile(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain("const host = '127.0.0.1';");
    expect(config).toContain('npm run start -- --hostname ${host}');

    const prod = await fs.readFile(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    const prodPublished = [...prod.matchAll(/^\s*-\s*"(\S+:3000)"\s*$/gm)].map(([, entry]) => entry);
    // web's, always loopback, and #14's curator, loopback on 3001 unless the
    // owner opts into LAN mode (policy.ts refuses 0.0.0.0 and public addresses).
    expect(prodPublished).toEqual([
      '127.0.0.1:${PHOTOGRAPHY_PORT:-3000}:3000',
      '${CURATOR_PUBLISH:-127.0.0.1}:${CURATOR_HOST_PORT:-3001}:3000',
    ]);
    // The curator flag only on curator, the last service. ci/check-compose.sh
    // checks the resolved file in CI.
    const [beforeCurator, curator] = prod.split(/^  curator:$/m);
    expect(curator).toContain('- CURATION_ENABLED=true');
    expect(beforeCurator).not.toContain('CURATION_ENABLED=');
    expect(beforeCurator).not.toContain('CURATION_BIND_SCOPE=');

    const smoke = await fs.readFile(path.join(REPO_ROOT, 'ci', 'smoke-image.sh'), 'utf8');
    expect(smoke).toMatch(/ports: !override\n\s*- "127\.0\.0\.1:\$PORT:3000"/);
    expect(smoke).toContain('PORT=${SMOKE_IMAGE_PORT:-3000}');
    expect(smoke).toContain('-f "$OVERRIDE"');
  });
});

describe('the image build', () => {
  // `next build` type-checks every file tsconfig.json includes, test files too,
  // and `.dockerignore` drops ci/ and e2e/ from the image context. So a module
  // the image keeps that imports from either breaks the image build with TS2307
  // while every local check stays green: every top-level folder and file is
  // scanned but the ones the image context drops, or that are built or installed
  // (A8's CI: __tests__/ imported e2e/, and only app/, components/ and lib/ were).
  const DROPPED = ['ci', 'e2e'];
  const SHIPPED = ['app', 'components', 'lib'];
  const UNSCANNED = new Set([...DROPPED, 'node_modules', '.git', '.next', 'dist', 'docs', '.github', 'test-results', 'playwright-report', 'blob-report', 'portfolio-data', 'site-config', 'public', 'playwright.config.ts']);
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

  /** The specifiers in `source` that resolve into a directory the image context drops. */
  function droppedImports(file, source) {
    return [...source.matchAll(SPECIFIER)]
      .map(([, , specifier]) => specifier)
      .filter((specifier) => {
        let target;
        if (specifier.startsWith('.')) target = path.resolve(path.dirname(file), specifier);
        else if (specifier.startsWith('@/')) target = path.join(REPO_ROOT, specifier.slice(2));
        else return false;
        return DROPPED.includes(path.relative(REPO_ROOT, target).split(path.sep)[0]);
      });
  }

  it('flags an import from ci/ or e2e/, relative or through @/', () => {
    const file = path.join(REPO_ROOT, 'app', '__tests__', 'probe.test.tsx');
    expect(droppedImports(file, "const { DYNAMIC_PATHS } = await import('../../ci/check-prerender.mjs');")).toEqual(['../../ci/check-prerender.mjs']);
    expect(droppedImports(file, "import { x } from '@/e2e/support/x';\nexport * from \"../../ci/y\";")).toEqual(['@/e2e/support/x', '../../ci/y']);
    expect(droppedImports(file, "import { x } from '@/lib/ci/x';\nimport '../ci/z';\nimport y from 'ci';")).toEqual([]);
  });

  it('has no module the image keeps importing from ci/ or e2e/', async () => {
    const offenders = [];
    let scanned = 0;
    const top = (await fs.readdir(REPO_ROOT, { withFileTypes: true })).filter((entry) => !UNSCANNED.has(entry.name));
    expect(top.map((entry) => entry.name)).toEqual(expect.arrayContaining(['app', 'components', 'lib', '__tests__', 'test', 'scripts', 'utils']));
    const files = [];
    for (const entry of top) {
      if (entry.isFile()) files.push(entry);
      else if (entry.isDirectory()) files.push(...(await fs.readdir(path.join(REPO_ROOT, entry.name), { recursive: true, withFileTypes: true })));
    }
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      // What the build type-checks: tsconfig.json includes every .ts and .tsx, and JavaScript only where shipped code imports it.
      const shipped = SHIPPED.includes(path.relative(REPO_ROOT, file).split(path.sep)[0]);
      if (!/\.tsx?$/.test(entry.name) && !(shipped && /\.[cm]?jsx?$/.test(entry.name))) continue;
      scanned += 1;
      for (const specifier of droppedImports(file, await fs.readFile(file, 'utf8'))) offenders.push(`${path.relative(REPO_ROOT, file)}: ${specifier}`);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('the legacy photo list', () => {
  // #13's slice E removed /api/photos, which answers 404 now. The issue's own
  // check, and the same check for a fetch() that passes options, find nothing
  // outside the tests: no page, script or doc asks for the list.
  const TESTS = /(^|\/)(__tests__|e2e|test)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

  /** The `file:line:text` lines `git grep` finds for `patterns`, outside the tests. */
  async function outsideTests(args) {
    const { stdout } = await promisify(execFile)('git', ['grep', '-n', ...args], { cwd: REPO_ROOT }).catch((error) => {
      // git grep exits 1 when it finds nothing.
      if (error.code === 1) return { stdout: '' };
      throw error;
    });
    return stdout.split('\n').filter(Boolean).filter((line) => !TESTS.test(line.slice(0, line.indexOf(':'))));
  }

  it("is asked for nowhere outside the tests: git grep -e \"fetch('/api/photos')\" -e \"localhost:3000/api/photos\"", async () => {
    expect(await outsideTests(['-e', "fetch('/api/photos')", '-e', 'localhost:3000/api/photos'])).toEqual([]);
  });

  it('is fetched nowhere outside the tests, with or without options', async () => {
    expect(await outsideTests(['-E', '-e', 'fetch\\([\'"`]/api/photos[\'"`?]'])).toEqual([]);
  });
});

describe("CI's retried browser installs", () => {
  /**
   * Every workflow step that retries a bounded install: its step timeout, how many tries, each try's bound, and the
   * bound on the clean-up between tries. Read as text, one step to a block, as the other workflow tests do.
   */
  async function retriedSteps() {
    const dir = path.join(REPO_ROOT, '.github', 'workflows');
    const steps = [];
    for (const name of (await fs.readdir(dir)).filter((file) => /\.ya?ml$/.test(file)).sort()) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      for (const step of text.split(/\n(?= +- (?:name|uses|run|if|id):)/)) {
        const loop = /for try in ([\d ]+); do/.exec(step);
        if (!loop) continue;
        steps.push({
          where: `${name}: ${/name: (.+)/.exec(step)?.[1] ?? 'a step'}`,
          minutes: Number(/timeout-minutes: (\d+)/.exec(step)?.[1]),
          tries: loop[1].trim().split(/\s+/).length,
          tryBound: Number(/\btimeout (\d+) npx playwright install\b/.exec(step)?.[1]),
          cleanupBound: Number(/\btimeout (\d+) dpkg --configure -a\b/.exec(step)?.[1]),
        });
      }
    }
    return steps;
  }

  it('give every try its full bound, and the clean-up between tries its own, inside the step timeout with a minute to spare', async () => {
    const steps = await retriedSteps();
    expect(steps.map((step) => step.where)).toEqual(['ci.yml: Install Playwright browsers', 'ci.yml: Install Chromium']);
    for (const step of steps) {
      // A hung dpkg would otherwise eat the next try's time, so the clean-up is bounded too.
      expect(step.cleanupBound, step.where).toBeGreaterThan(0);
      const worst = step.tries * step.tryBound + (step.tries - 1) * step.cleanupBound;
      expect(step.minutes * 60, `${step.where}: ${step.tries} tries of ${step.tryBound} s and ${step.tries - 1} clean-ups of ${step.cleanupBound} s`).toBeGreaterThanOrEqual(worst + 60);
    }
  });
});

describe("the smokes' temp roots", () => {
  it('go under $RUNNER_TEMP, the job\'s own temp folder in CI, or $TMPDIR elsewhere, each named for its smoke', async () => {
    const dir = path.join(REPO_ROOT, 'ci');
    const smokes = (await fs.readdir(dir)).filter((name) => /^smoke-.+\.sh$/.test(name)).sort();
    expect(smokes).toEqual(['smoke-catalog.sh', 'smoke-image.sh', 'smoke-ingest.sh', 'smoke-media.sh', 'smoke-watcher-once.sh']);
    for (const name of smokes) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      const calls = [...text.matchAll(/mktemp\b[^)\n]*/g)].map((match) => match[0]);
      expect(calls, name).toEqual([`mktemp -d "\${RUNNER_TEMP:-\${TMPDIR:-/tmp}}/photography-${name.replace(/\.sh$/, '')}.XXXXXX"`]);
    }
  });
});
