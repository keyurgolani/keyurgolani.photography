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

/** Seconds in a timeout(1) or sleep(1) duration: a number with an optional s, m, h or d. NaN when it isn't one. */
function seconds(duration) {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(duration ?? '');
  return match ? Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]] : NaN;
}

/** A shell line's commands, split on unquoted `&&`, `||`, `;` and `|`, so a quoted 'apt-get|dpkg' stays whole. */
function commandsOf(line) {
  const commands = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') current += line[(i += 1)] ?? '';
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '#' && /^\s?$/.test(line[i - 1] ?? '')) break;
    else if ('&|;'.includes(char)) {
      if (line[i + 1] === char && char !== ';') i += 1;
      commands.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  commands.push(current);
  return commands.map((command) => command.trim()).filter(Boolean);
}

/** Commands that return at once, so a try's clean-up needs no bound on them. Anything else must run under timeout. */
const PROMPT = new Set(['echo', 'printf', 'true', 'false', ':', 'exit', 'break', 'continue', 'pkill', 'kill', 'sed', '[', 'test']);

/**
 * The longest one command can take, in seconds: `timeout [-k K] N cmd`, under sudo or not, takes at most N + K, and
 * `sleep N` N. A command PROMPT names takes none. Anything else is unbounded: Infinity.
 */
function boundOf(command) {
  const words = command.split(/\s+/).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
  if (words[0] === 'sudo') words.shift();
  if (words[0] === 'sleep') return seconds(words[1]) || Infinity;
  if (words[0] === 'timeout') {
    let kill = 0;
    let at = 1;
    for (; at < words.length && words[at].startsWith('-'); at += 1) {
      const word = words[at];
      if (word === '-k' || word === '--kill-after') kill = seconds(words[(at += 1)]);
      else if (word.startsWith('--kill-after=')) kill = seconds(word.slice('--kill-after='.length));
      else if (/^-k\d/.test(word)) kill = seconds(word.slice(2));
      else if (word === '-s' || word === '--signal') at += 1;
      else if (!/^(?:--signal=.+|--preserve-status|--foreground|-v|--verbose)$/.test(word)) return Infinity;
    }
    const bound = seconds(words[at]) + kill;
    return Number.isFinite(bound) && words.length > at + 1 ? bound : Infinity;
  }
  return PROMPT.has(words[0]) ? 0 : Infinity;
}

/** How many times a loop header runs its body: a list of numbers, {A..B}, $(seq [A] B), or for ((V = A; V <= B; V++)). */
function triesOf(header) {
  let match = /^for (\w+) in (\d+(?: +\d+)*) *(?:;|$)/.exec(header);
  if (match) return match[2].trim().split(/ +/).length;
  match = /^for (\w+) in \{(\d+)\.\.(\d+)\} *(?:;|$)/.exec(header);
  if (match) return Number(match[3]) - Number(match[2]) + 1;
  match = /^for (\w+) in (?:\$\(|`)seq (?:(\d+) +)?(\d+)(?:\)|`) *(?:;|$)/.exec(header);
  if (match) return Number(match[3]) - Number(match[2] ?? 1) + 1;
  match = /^for \(\( *(\w+) *= *(\d+) *; *\1 *(<=?) *(\d+) *; *(?:\1\+\+|\+\+\1|\1 *\+= *1) *\)\) *(?:;|$)/.exec(header);
  if (match) return Number(match[4]) - Number(match[2]) + (match[3] === '<=' ? 1 : 0);
  return NaN;
}

/**
 * Every workflow step with a loop that retries: one whose body leaves on a command's success (`... && exit 0` or
 * `&& break`), or whose variable is a try or an attempt. Each with its step timeout, how many tries, the longest one
 * pass through the body takes (every timeout and sleep in it, the last try's clean-up too), and the body's commands
 * that have no bound. Read as text, one step to a block, as the other workflow tests do.
 */
function retriedStepsIn(name, text) {
  const steps = [];
  for (const step of text.split(/\n(?= +- (?:name|uses|run|if|id):)/)) {
    const lines = step.split('\n');
    for (let at = 0; at < lines.length; at += 1) {
      // A loop's header, with its `do` on the same line or the next.
      const header = /^( *)((?:for|while|until)\s.*?)(; *do)? *$/.exec(lines[at]);
      if (!header || (!header[3] && lines[at + 1]?.trim() !== 'do')) continue;
      const indent = header[1];
      const close = lines.findIndex((line, index) => index > at && (line === `${indent}done` || line.startsWith(`${indent}done `)));
      const body = lines.slice(header[3] ? at + 1 : at + 2, close < 0 ? undefined : close).filter((line) => !/^\s*#/.test(line));
      const variable = /^for (?:\(\( *)?(\w+)/.exec(header[2])?.[1] ?? '';
      const leavesOnSuccess = body.some((line) => /&& *(?:exit 0|break)\b/.test(line));
      if (!leavesOnSuccess && !/^(?:try|tries|attempt|attempts|retry|retries)$/.test(variable)) continue;
      const commands = body.flatMap(commandsOf);
      steps.push({
        where: `${name}: ${/name: (.+)/.exec(step)?.[1] ?? 'a step'}`,
        header: header[2],
        closed: close >= 0,
        minutes: Number(/timeout-minutes: (\d+)/.exec(step)?.[1]),
        tries: triesOf(header[2]),
        pass: commands.reduce((sum, command) => sum + boundOf(command), 0),
        unbounded: commands.filter((command) => boundOf(command) === Infinity),
      });
    }
  }
  return steps;
}

describe("CI's retried steps", () => {
  async function retriedSteps() {
    const dir = path.join(REPO_ROOT, '.github', 'workflows');
    const steps = [];
    for (const name of (await fs.readdir(dir)).filter((file) => /\.ya?ml$/.test(file)).sort()) {
      steps.push(...retriedStepsIn(name, await fs.readFile(path.join(dir, name), 'utf8')));
    }
    return steps;
  }

  /** A step as ci.yml writes its retried installs, with `body` for the loop's body. */
  const fixture = (body, { header = 'for try in 1 2 3; do', minutes = 22 } = {}) =>
    ['      - name: Fixture', `        timeout-minutes: ${minutes}`, '        run: |', `          ${header}`, ...body.map((line) => `            ${line}`), '          done', '          exit 1', ''].join('\n');
  const read = (...args) => retriedStepsIn('fixture.yml', fixture(...args));
  const INSTALL = 'timeout 360 npx playwright install --with-deps --only-shell chromium && exit 0';
  const CLEAN_UP = ["sudo pkill -9 -f 'apt-get|dpkg' || true", 'sudo timeout 60 dpkg --configure -a || true'];

  it('counts every timeout and sleep in the body, a timeout -k as its bound plus its grace, and nothing else as bounded', () => {
    expect(read([INSTALL, 'echo "try $try failed"', ...CLEAN_UP])).toMatchObject([{ tries: 3, pass: 420, unbounded: [] }]);
    expect(read([INSTALL, ...CLEAN_UP, 'sleep 300'])[0].pass).toBe(720);
    expect(read([INSTALL, ...CLEAN_UP, 'sleep 2m'])[0].pass).toBe(540);
    expect(read([INSTALL.replace('timeout 360', 'timeout -k 30 360'), ...CLEAN_UP])[0].pass).toBe(450);
    expect(read([INSTALL.replace('timeout 360', 'timeout --kill-after=30s 6m'), ...CLEAN_UP])[0].pass).toBe(450);
    expect(read([INSTALL, 'timeout 360 npx playwright install-deps || true', ...CLEAN_UP])[0].pass).toBe(780);
    expect(read([INSTALL, ...CLEAN_UP, 'sudo dpkg --configure -a || true'])[0].unbounded).toEqual(['sudo dpkg --configure -a']);
    expect(read([INSTALL.replace('timeout 360 ', ''), ...CLEAN_UP])[0].unbounded).toEqual(['npx playwright install --with-deps --only-shell chromium']);
    // A timeout with no command, or an option it doesn't know, bounds nothing.
    expect(read([INSTALL.replace('timeout 360', 'timeout --bogus 360'), ...CLEAN_UP])[0].unbounded).toHaveLength(1);
  });

  it('finds a retried step of any loop shape, and counts its tries where the header says', () => {
    for (const [header, tries] of [['for try in 1 2 3; do', 3], ['for try in {1..4}; do', 4], ['for try in $(seq 3); do', 3], ['for attempt in $(seq 2 5); do', 4], ['for ((try = 1; try <= 3; try++)); do', 3], ['for ((n=0; n<2; n++)); do', 2]]) {
      expect(read([INSTALL, ...CLEAN_UP], { header }), header).toMatchObject([{ tries }]);
    }
    for (const header of ['while [ "$try" -le 3 ]; do', 'until timeout 360 npx playwright install; do', 'for try in $TRIES; do']) {
      expect(read([INSTALL, ...CLEAN_UP], { header }), header).toMatchObject([{ tries: NaN }]);
    }
    // Not a retry: a loop over items that never leaves on success.
    expect(read(['echo "$tag"'], { header: 'for tag in "${tags[@]}"; do' })).toEqual([]);
  });

  it('give every pass through the loop its full bound, with no unbounded command, inside the step timeout with a minute to spare', async () => {
    const steps = await retriedSteps();
    expect(steps.map((step) => step.where)).toEqual(['ci.yml: Install Playwright browsers', 'ci.yml: Install Chromium']);
    for (const step of steps) {
      expect(step.closed, `${step.where}: the loop's done`).toBe(true);
      expect(Number.isInteger(step.tries) && step.tries > 0, `${step.where}: can't count the tries of "${step.header}"; write it as for try in 1 2 3`).toBe(true);
      // A hung dpkg would otherwise eat the next try's time, so the clean-up is bounded too.
      expect(step.unbounded, `${step.where}: commands in the loop with no bound`).toEqual([]);
      const worst = step.tries * step.pass;
      expect(step.minutes * 60, `${step.where}: ${step.tries} passes of at most ${step.pass} s`).toBeGreaterThanOrEqual(worst + 60);
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

describe("Perf A/B's wiring", () => {
  /** perf-ab.yml's steps, each as its step-level keys (`name`, `uses`, `with`, `env`, `run`, ...) and their text. */
  async function perfAbSteps() {
    const text = await fs.readFile(path.join(REPO_ROOT, '.github', 'workflows', 'perf-ab.yml'), 'utf8');
    const steps = text.slice(text.indexOf('\n    steps:\n')).split(/\n(?= {6}- )/).slice(1);
    return steps.map((step) => {
      const keys = {};
      let key = '';
      for (const line of step.split('\n')) {
        const match = /^ {6}(?:- | {2})([a-z-]+):(.*)$/.exec(line);
        if (match) [key, keys[match[1]]] = [match[1], match[2]];
        else if (key) keys[key] += `\n${line}`;
      }
      return { name: (keys.name ?? keys.uses ?? '').trim(), keys };
    });
  }

  it('checks out the base and the head at the SHAs the resolver gives, from a tool clone with every commit', async () => {
    const steps = await perfAbSteps();
    const named = (name) => steps.find((step) => step.name === name);
    expect(named('Check out the tool')?.keys.with).toMatch(/\n {10}fetch-depth: 0\n/);
    for (const which of ['base', 'head']) {
      const resolve = named(`Resolve the ${which}`);
      expect(resolve?.keys.id?.trim(), which).toBe(which);
      expect(resolve?.keys.run, which).toContain('bash tool/ci/perf/resolve-ref.sh tool/.git');
      expect(named(`Check out the ${which}`)?.keys.with, which).toMatch(new RegExp(`\\n {10}ref: \\$\\{\\{ steps\\.${which}\\.outputs\\.sha \\}\\}\\n`));
      // Resolved before it's checked out.
      expect(steps.indexOf(resolve), which).toBeLessThan(steps.indexOf(named(`Check out the ${which}`)));
    }
  });

  it('passes its inputs to the scripts only through env, never as ${{ inputs.* }} in a run or a with', async () => {
    const steps = await perfAbSteps();
    const uses = steps.flatMap(({ name, keys }) => Object.entries(keys).filter(([, text]) => /\binputs\./.test(text)).map(([key]) => `${name}: ${key}`));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((use) => !use.endsWith(': env'))).toEqual([]);
  });
});
