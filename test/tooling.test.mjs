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

/**
 * A shell script's simple commands, in order: split on unquoted newlines, `;`, `&&`, `||`, `|` and `&` (not the `&`
 * of a redirection such as `>&2`), with comments dropped. Quotes, $(…), `…`, ${…} and ((…)) stay whole inside their
 * command, across lines too, so a quoted 'apt-get|dpkg' or a jq program over several lines is one word. With them,
 * what this reading can't follow, so a check can refuse it: how many for, while and until words stand unquoted in the
 * code (inside $( ), ( ) and `…` too), and whether the code has a heredoc (<<, not the <<< here-string) or an ANSI-C
 * $'…' quote, whose lines and escapes it reads as plain shell.
 */
function scan(script) {
  const commands = [];
  let loopWords = 0;
  let heredoc = false;
  let ansiC = false;
  /** What's open, innermost last: ', ", `, $(, (, ${ or ((. */
  const open = [];
  let current = '';
  const end = () => {
    if (current.trim()) commands.push(current.trim());
    current = '';
  };
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];
    const top = open.at(-1);
    if (top === undefined || top === '$(' || top === '(' || top === '`') {
      if (/^(?:for|while|until)(?=[\s;(]|$)/.test(script.slice(i, i + 6)) && /^[\s;&|()`{]?$/.test(script[i - 1] ?? '')) loopWords += 1;
      if (char === '<' && next === '<' && script[i + 2] !== '<' && script[i - 1] !== '<') heredoc = true;
      if (char === '$' && next === "'") ansiC = true;
    }
    if (top === "'" || top === '`') {
      current += char;
      if (char === top) open.pop();
      continue;
    }
    if (char === '\\') {
      current += char + (next ?? '');
      i += 1;
      continue;
    }
    if (top === '"' || top === '${') {
      current += char;
      if ((top === '"' && char === '"') || (top === '${' && char === '}')) open.pop();
      else if (char === '`' || (top === '${' && (char === "'" || char === '"'))) open.push(char);
      else if (char === '$' && (next === '(' || next === '{')) {
        current += next;
        i += 1;
        open.push(`$${next}`);
      }
      continue;
    }
    if (top === '((') {
      current += char;
      if (char === ')' && next === ')') {
        current += next;
        i += 1;
        open.pop();
      }
      continue;
    }
    // Unquoted: at the top, or inside $( ) or ( ).
    if (char === "'" || char === '"' || char === '`') open.push(char);
    else if ((char === '$' && next === '(' && script[i + 2] === '(') || (char === '(' && next === '(')) {
      const opener = char === '$' ? '$((' : '((';
      current += opener;
      i += opener.length - 1;
      open.push('((');
      continue;
    } else if (char === '$' && (next === '(' || next === '{')) {
      current += char + next;
      i += 1;
      open.push(`$${next}`);
      continue;
    } else if (char === '(') open.push('(');
    else if (char === ')' && (top === '$(' || top === '(')) open.pop();
    else if (open.length === 0) {
      if (char === '#' && /^\s?$/.test(script[i - 1] ?? '')) {
        while (i + 1 < script.length && script[i + 1] !== '\n') i += 1;
        continue;
      }
      if (char === '\n' || char === ';') {
        end();
        continue;
      }
      const redirection = char === '&' && (/[<>]/.test(script[i - 1] ?? '') || next === '>');
      if ((char === '&' || char === '|') && !redirection) {
        if (next === char || (char === '|' && next === '&')) i += 1;
        end();
        continue;
      }
    }
    current += char;
  }
  end();
  return { commands, loopWords, heredoc, ansiC };
}

const commandsOf = (script) => scan(script).commands;

/** Commands that return at once, so a try's clean-up needs no bound on them. Anything else must run under timeout. */
const PROMPT = new Set(['echo', 'printf', 'true', 'false', ':', 'exit', 'break', 'continue', 'pkill', 'kill', 'sed', '[', 'test']);

/**
 * The longest one command can take, in seconds: `timeout [-k K] N cmd`, under sudo or not, takes at most N + K, and
 * `sleep N` N. A command PROMPT names takes none. Anything else is unbounded, Infinity: so is any command with a
 * command substitution in it, whatever its first word, since what it runs has no bound of its own, and a timeout of 0,
 * or a -k of 0, which GNU timeout reads as no limit and no kill.
 */
function boundOf(command) {
  if (/\$\(|`|[<>]\(/.test(command)) return Infinity;
  const words = command.split(/\s+/);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
  if (words.length === 0) return 0;
  if (words[0] === 'sudo') words.shift();
  if (words[0] === 'sleep') return Number.isFinite(seconds(words[1])) ? seconds(words[1]) : Infinity;
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
      if (kill === 0 && /^(?:-k|--kill-after)/.test(word)) return Infinity;
    }
    const limit = seconds(words[at]);
    return limit > 0 && Number.isFinite(kill) && words.length > at + 1 ? limit + kill : Infinity;
  }
  return PROMPT.has(words[0]) ? 0 : Infinity;
}

/** How many times a loop header runs its body: a list of numbers, {A..B}, $(seq [A] B), or for ((V = A; V <= B; V++)). */
function triesOf(header) {
  let match = /^for (\w+) in (\d+(?: +\d+)*)$/.exec(header);
  if (match) return match[2].trim().split(/ +/).length;
  match = /^for (\w+) in \{(\d+)\.\.(\d+)\}$/.exec(header);
  if (match) return Number(match[3]) - Number(match[2]) + 1;
  match = /^for (\w+) in (?:\$\(|`)seq (?:(\d+) +)?(\d+)(?:\)|`)$/.exec(header);
  if (match) return Number(match[3]) - Number(match[2] ?? 1) + 1;
  match = /^for \(\( *(\w+) *= *(\d+) *; *\1 *(<=?) *(\d+) *; *(?:\1\+\+|\+\+\1|\1 *\+= *1) *\)\)$/.exec(header);
  if (match) return Number(match[4]) - Number(match[2]) + (match[3] === '<=' ? 1 : 0);
  return NaN;
}

/**
 * A script's loops, every for, while and until, nested ones too, each with its header, how many times it runs (NaN
 * where the header doesn't say), the commands one pass runs (a while or until loop's condition among them) and the
 * loops inside it. The words that lead a command (if, then, else, do, !) are read past, since what follows them runs.
 */
function loopsIn(script) {
  const loops = [];
  const stack = [];
  for (let command of commandsOf(script)) {
    for (let lead; (lead = /^(?:if|elif|then|else|do|!|\{)(?:\s+|$)/.exec(command)); ) command = command.slice(lead[0].length);
    if (!command || /^(?:fi|esac|\}|;;)(?:\s|$)/.test(command)) continue;
    if (/^done(?:\s|$)/.test(command)) {
      const loop = stack.pop();
      if (loop) loop.closed = true;
      continue;
    }
    const kind = /^(for|while|until)\s/.exec(command)?.[1];
    if (kind) {
      const loop = { header: command, tries: triesOf(command), commands: kind === 'for' ? [] : [command.slice(kind.length).trim()], inner: [], closed: false };
      stack.at(-1)?.inner.push(loop);
      stack.push(loop);
      loops.push(loop);
      continue;
    }
    stack.at(-1)?.commands.push(command);
  }
  return loops;
}

/** The longest one pass through `loop` takes, its inner loops' every pass included. */
const passOf = (loop) => loop.commands.reduce((sum, command) => sum + boundOf(command), 0) + loop.inner.reduce((sum, inner) => sum + inner.tries * passOf(inner), 0);
const unboundedIn = (loop) => [...loop.commands.filter((command) => boundOf(command) === Infinity), ...loop.inner.flatMap(unboundedIn)];

/** The keys a workflow step can start with, so a `- name:` under `steps:` is told from a list item elsewhere. */
const STEP_KEYS = new Set(['name', 'uses', 'run', 'if', 'id', 'env', 'with', 'shell', 'timeout-minutes', 'working-directory', 'continue-on-error']);

/** Each step's run script in a workflow, with the step's name and its own timeout-minutes, read as text. */
function runsIn(text) {
  const lines = text.split('\n');
  const runs = [];
  for (let at = 0; at < lines.length; at += 1) {
    const item = /^( *)- ([a-z-]+):/.exec(lines[at]);
    if (!item || !STEP_KEYS.has(item[2])) continue;
    const keyIndent = item[1].length + 2;
    let end = at + 1;
    while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) >= keyIndent)) end += 1;
    const step = [' '.repeat(keyIndent) + lines[at].slice(keyIndent), ...lines.slice(at + 1, end)];
    const keys = {};
    let script = null;
    for (let k = 0; k < step.length; k += 1) {
      const key = /^ *([a-z-]+):(.*)$/.exec(step[k]);
      if (!key || step[k].search(/\S/) !== keyIndent) continue;
      if (key[1] !== 'run') keys[key[1]] = key[2].trim();
      else if (/^[|>][-+]?$/.test(key[2].trim())) {
        let last = k + 1;
        while (last < step.length && (step[last].trim() === '' || step[last].search(/\S/) > keyIndent)) last += 1;
        const block = step.slice(k + 1, last);
        const indent = Math.min(...block.filter((line) => line.trim()).map((line) => line.search(/\S/)));
        script = block.map((line) => line.slice(indent)).join('\n');
      } else script = key[2].trim();
    }
    if (script !== null) runs.push({ name: keys.name ?? 'a step', minutes: Number(keys['timeout-minutes']), script });
    at = end - 1;
  }
  return runs;
}

/**
 * Every loop in a workflow's run scripts: each a candidate retry, with its step timeout, how many tries, the longest
 * one pass takes (every timeout and sleep in it, the last try's clean-up too), and the commands in it with no bound.
 */
function retriedStepsIn(name, text) {
  return runsIn(text).flatMap((run) =>
    loopsIn(run.script).map((loop) => ({
      where: `${name}: ${run.name}`,
      header: loop.header,
      closed: loop.closed,
      minutes: run.minutes,
      tries: loop.tries,
      pass: passOf(loop),
      unbounded: unboundedIn(loop),
    })),
  );
}

/**
 * The workflows' loops that aren't retries, each with how many loops of that header the step has and why it needn't
 * fit the retry rule. Every other loop in a workflow's run is held to it.
 */
const NOT_RETRIES = {
  'ci.yml: Require every job to succeed: while read -r job result': { loops: 1, why: 'reads the needs results from a here-string, one pass a job, and waits on nothing' },
  'release.yml: Wait for the main publish of this commit: while :': { loops: 1, why: 'a poll, not a retry: its own 40-minute deadline on $SECONDS and 30 s between polls, inside the job\'s 50' },
  'release.yml: Promote the image: for tag in "${tags[@]}"': { loops: 2, why: 'one pass for each of at most two tags, building an argument list, then reading each tag back' },
  'mirror-dockerhub.yml: Copy the image by digest: for tag in "${requested[@]}"': { loops: 1, why: 'one pass for each tag the dispatch asked for, reading GHCR latest at most once' },
  'mirror-dockerhub.yml: Copy the image by digest: for tag in "${tags[@]}"': { loops: 2, why: 'one pass for each tag kept, building an argument list, then reading each tag back' },
};

/**
 * What's wrong with a workflow's loops, one message each: every loop must be one the reading places, in a step it
 * can read, and a loop NOT_RETRIES doesn't list must close, have tries the header counts, no command without a bound,
 * and fit its step timeout with a minute to spare.
 */
function problemsIn(name, text) {
  const problems = [];
  // What the reading can't follow fails loudly, rather than being misread.
  for (const run of runsIn(text)) {
    const { loopWords, heredoc, ansiC } = scan(run.script);
    const where = `${name}: ${run.name}`;
    if (loopWords > loopsIn(run.script).length) problems.push(`${where}: a loop the check can't place, in a case arm, ( ), $( ) or after time; write it as its own for, while or until command`);
    if (loopWords > 0 && heredoc) problems.push(`${where}: heredocs aren't read; in a step with a loop, use a here-string or a file`);
    if (loopWords > 0 && ansiC) problems.push(`${where}: ANSI-C quotes aren't read; in a step with a loop, use printf or a plain quote`);
  }
  for (const step of retriedStepsIn(name, text)) {
    const where = `${step.where}: ${step.header}`;
    if (where in NOT_RETRIES) continue;
    if (!step.closed) problems.push(`${where}: the loop has no done`);
    if (!(Number.isInteger(step.tries) && step.tries > 0)) problems.push(`${where}: can't count the tries; write it as for try in 1 2 3, or list it in NOT_RETRIES with why`);
    // A hung dpkg would otherwise eat the next try's time, so the clean-up is bounded too.
    if (step.unbounded.length > 0) problems.push(`${where}: commands in the loop with no bound: ${step.unbounded.join('; ')}`);
    else if (!(step.minutes * 60 >= step.tries * step.pass + 60)) problems.push(`${where}: ${step.tries} passes of at most ${step.pass} s need more than ${step.minutes} minutes less one`);
  }
  return problems;
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
    for (const header of ['while [ "$try" -le 3 ]; do', 'until timeout 360 npx playwright install; do', 'for try in $TRIES; do', 'for tag in "${tags[@]}"; do']) {
      expect(read([INSTALL, ...CLEAN_UP], { header }), header).toMatchObject([{ header: header.replace(/; do$/, ''), tries: NaN }]);
    }
  });

  /** A step whose run is `script`, line for line. */
  const steps = (script, minutes = 22) => retriedStepsIn('fixture.yml', ['      - name: Fixture', `        timeout-minutes: ${minutes}`, '        run: |', ...script.map((line) => `          ${line}`), ''].join('\n'));

  it('counts a command substitution as unbounded, whatever command it sits in, and timeout 0 or -k 0 too', () => {
    expect.soft(read([INSTALL, 'echo "$(sudo apt-get update)"', ...CLEAN_UP])[0].unbounded).toEqual(['echo "$(sudo apt-get update)"']);
    expect.soft(read([INSTALL, '[ -n "`sudo apt-get update`" ] || true', ...CLEAN_UP])[0].unbounded).toEqual(['[ -n "`sudo apt-get update`" ]']);
    expect.soft(read(['[ -n "$(sudo apt-get update)" ] && exit 0', ...CLEAN_UP])[0].unbounded).toEqual(['[ -n "$(sudo apt-get update)" ]']);
    // GNU timeout reads a duration of 0 as no limit, and a kill-after of 0 as no kill.
    expect.soft(read([INSTALL.replace('timeout 360', 'timeout 0'), ...CLEAN_UP])[0].unbounded).toHaveLength(1);
    expect.soft(read([INSTALL.replace('timeout 360', 'timeout -k 0 360'), ...CLEAN_UP])[0].unbounded).toHaveLength(1);
    expect.soft(read([INSTALL, ...CLEAN_UP, 'sleep 0'])[0]).toMatchObject({ pass: 420, unbounded: [] });
  });

  it('finds a loop written on one line, an until loop, and a for loop that leaves from inside an if', () => {
    expect.soft(steps([`for try in 1 2 3; do ${INSTALL}; sleep 600; done`, 'exit 1'])).toMatchObject([{ header: 'for try in 1 2 3', tries: 3, pass: 960, unbounded: [] }]);
    expect.soft(steps(['until timeout 360 npx playwright install; do sleep 600; done'])).toMatchObject([{ header: 'until timeout 360 npx playwright install', tries: NaN, pass: 960 }]);
    expect.soft(steps(['for i in 1 2 3; do', '  if timeout 360 npx playwright install; then exit 0; fi', '  sleep 600', 'done', 'exit 1'])).toMatchObject([{ header: 'for i in 1 2 3', tries: 3, pass: 960, unbounded: [] }]);
  });

  it('finds every loop in a workflow run, and knows each one that is no retry', async () => {
    const found = {};
    for (const step of await retriedSteps()) {
      const key = `${step.where}: ${step.header}`;
      if (key in NOT_RETRIES) found[key] = (found[key] ?? 0) + 1;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(NOT_RETRIES).map(([key, { loops }]) => [key, loops])));
  });

  const workflows = async () => {
    const dir = path.join(REPO_ROOT, '.github', 'workflows');
    const names = (await fs.readdir(dir)).filter((file) => /\.ya?ml$/.test(file)).sort();
    return Promise.all(names.map(async (name) => [name, await fs.readFile(path.join(dir, name), 'utf8')]));
  };

  it('give every pass through the loop its full bound, with no unbounded command, inside the step timeout with a minute to spare', async () => {
    const steps = (await retriedSteps()).filter((step) => !(`${step.where}: ${step.header}` in NOT_RETRIES));
    // Soft, so a new loop also says what's wrong with it below.
    expect.soft(steps.map((step) => step.where)).toEqual(['ci.yml: Install Playwright browsers', 'ci.yml: Install Chromium']);
    expect((await workflows()).flatMap(([name, text]) => problemsIn(name, text))).toEqual([]);
  });

  it("refuses what it can't read rather than misread it: a loop it can't place, and a heredoc or an ANSI-C quote in a step with a loop", async () => {
    const ci = (await workflows()).find(([name]) => name === 'ci.yml')[1];
    const LOOP = '          for try in 1 2 3; do\n            timeout 360 npx playwright install --with-deps --only-shell chromium && exit 0\n';
    expect(ci).toContain(LOOP);
    const before = (line) => `          ${line}\n${LOOP}`;
    const inside = (...lines) => `${LOOP}${lines.map((line) => `            ${line}\n`).join('')}`;
    const PLACE = "a loop the check can't place";
    for (const [mutant, text, problem] of [
      ['a loop in a case arm', before('case "$RUNNER_OS" in Linux) for t in 1 2 3; do sleep 600; done ;; esac'), PLACE],
      ['a loop in a subshell', before('( for t in 1 2 3; do sleep 600; done )'), PLACE],
      ['a loop in a command substitution', before('waited=$(for t in 1 2 3; do sleep 600; done)'), PLACE],
      ['a loop after time', before('time for t in 1 2 3; do sleep 600; done'), PLACE],
      // A heredoc's lines aren't commands: here its done line would end the retry loop early, and hide the sleep 600.
      ['a heredoc in a step with a loop', inside("sed 's/^/  /' <<'EOF'", '  done', '  EOF', 'sleep 600').replace(/\n {12} {2}(done|EOF)\n/g, '\n          $1\n'), "heredocs aren't read"],
      // $'it\'s' ends at its escaped quote for a plain reading, which then swallows the sleep 600 into the echo.
      ['an ANSI-C quote in a step with a loop', inside("echo $'it\\'s'", 'sleep 600', "echo \\'"), "ANSI-C quotes aren't read"],
    ]) {
      // A function, since a replacement string reads $' as the text after the match.
      const mutated = ci.replace(LOOP, () => text);
      expect(mutated, mutant).not.toBe(ci);
      expect.soft(problemsIn('ci.yml', mutated).filter((message) => message.includes(problem)), mutant).toHaveLength(1);
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
  const perfAbText = () => fs.readFile(path.join(REPO_ROOT, '.github', 'workflows', 'perf-ab.yml'), 'utf8');
  const perfAbSteps = async () => perfAbStepsIn(await perfAbText());

  /** Where a step hands an input, or any expression, to a script other than through env: `<step>: <key>` each. */
  const leaks = (steps) =>
    steps.flatMap(({ name, keys }) =>
      Object.entries(keys)
        .filter(([key, text]) => (key === 'run' && text.includes('${{')) || (key !== 'env' && /\binputs\s*[.[]/.test(text)))
        .map(([key]) => `${name}: ${key}`),
    );

  /** perf-ab.yml's steps, each as its step-level keys (`name`, `uses`, `with`, `env`, `run`, ...) and their text. */
  function perfAbStepsIn(text) {
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
    expect(steps.some(({ keys }) => /\binputs\./.test(keys.env ?? ''))).toBe(true);
    expect(leaks(steps)).toEqual([]);
  });

  it('has no ${{ }} expression in any run, so neither env nor an input by index reaches a script as text', async () => {
    const text = await perfAbText();
    const resolve = 'sha=$(bash tool/ci/perf/resolve-ref.sh tool/.git "$BASE_INPUT")';
    expect.soft(text).toContain(resolve);
    for (const expression of ['${{ env.BASE_INPUT }}', "${{ inputs['head'] }}", '${{ github.event.inputs.base }}']) {
      const mutated = text.replace(resolve, `sha=$(bash tool/ci/perf/resolve-ref.sh tool/.git "${expression}")`);
      expect.soft(leaks(perfAbStepsIn(mutated)), expression).toEqual(['Resolve the base: run']);
    }
  });
});
