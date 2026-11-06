// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

// ci/perf/resolve-ref.sh, which Perf A/B runs before it checks out the head: a full or short SHA, a branch or a tag
// becomes the full SHA of one commit, and a ref that names none or more than one fails, saying which. Against a bare
// repository this test makes under os.tmpdir() and leaves there: it deletes nothing.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'ci', 'perf', 'resolve-ref.sh');
/** This test's own git runs: no global or system config, and nothing that points git at another repository. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(ENV, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
/** Enough commits that some share their first four hex digits. Fixed times, so the SHAs are the same every run. */
const COMMITS = 2000;

let gitDir = '';
let shas = [];
const git = (...args) => execFileSync('git', [`--git-dir=${gitDir}`, ...args], { env: ENV, encoding: 'utf8' }).trim();

beforeAll(() => {
  gitDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perf-resolve-ref-')), 'repo.git');
  execFileSync('git', ['init', '-q', '--bare', gitDir], { env: ENV });
  const lines = [];
  for (let n = 1; n <= COMMITS; n += 1) {
    const message = `Fixture commit ${n}\n`;
    lines.push('commit refs/heads/main', `mark :${n}`, `committer Fixture <fixture@example.invalid> ${1_700_000_000 + n} +0000`, `data ${Buffer.byteLength(message)}`, message.trimEnd());
    if (n > 1) lines.push(`from :${n - 1}`);
    lines.push('');
  }
  // As actions/checkout leaves a full fetch: the branches under refs/remotes/origin, the tags under refs/tags.
  lines.push('reset refs/remotes/origin/feature/fast', 'from :7', '');
  lines.push('reset refs/tags/v1.0.0', 'from :5', '');
  lines.push('tag v2.0.0', 'from :6', 'tagger Fixture <fixture@example.invalid> 1700000000 +0000', 'data 7', 'v2.0.0', '');
  lines.push('reset refs/remotes/origin/both', 'from :8', '', 'reset refs/tags/both', 'from :9', '');
  lines.push('reset refs/remotes/origin/same', 'from :10', '', 'reset refs/tags/same', 'from :10', '');
  execFileSync('git', [`--git-dir=${gitDir}`, 'fast-import', '--quiet'], { env: ENV, input: `${lines.join('\n')}\n` });
  shas = git('rev-list', '--reverse', 'main').split('\n');
});

const commit = (n) => shas[n - 1];

async function resolve(ref) {
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', [SCRIPT, gitDir, ref], { env: ENV });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('ci/perf/resolve-ref.sh', () => {
  it('gives a full SHA back as it is, and the full SHA of a short one, in either case', async () => {
    expect(await resolve(commit(3))).toEqual({ code: 0, stdout: `${commit(3)}\n`, stderr: '' });
    expect(await resolve(commit(3).slice(0, 12))).toMatchObject({ code: 0, stdout: `${commit(3)}\n` });
    expect(await resolve(commit(3).slice(0, 12).toUpperCase())).toMatchObject({ code: 0, stdout: `${commit(3)}\n` });
  });

  it('gives the commit a branch or a tag names, a lightweight or an annotated one', async () => {
    expect(await resolve('main')).toMatchObject({ code: 0, stdout: `${commit(COMMITS)}\n` });
    expect(await resolve('feature/fast')).toMatchObject({ code: 0, stdout: `${commit(7)}\n` });
    expect(await resolve('v1.0.0')).toMatchObject({ code: 0, stdout: `${commit(5)}\n` });
    expect(await resolve('v2.0.0')).toMatchObject({ code: 0, stdout: `${commit(6)}\n` });
    // A branch and a tag of one name on the same commit name one commit.
    expect(await resolve('same')).toMatchObject({ code: 0, stdout: `${commit(10)}\n` });
  });

  it('fails, saying so, on a ref that names no commit', async () => {
    for (const ref of ['no-such-branch', 'f'.repeat(40), 'fffff0']) {
      const run = await resolve(ref);
      expect(run.code, ref).toBe(1);
      expect(run.stdout, ref).toBe('');
      expect(run.stderr, ref).toContain(`::error::No branch, tag or commit is named '${ref}' in this repository.`);
    }
  });

  it('fails, naming each commit, on a short SHA two commits share', async () => {
    const byPrefix = new Map();
    for (const sha of shas) byPrefix.set(sha.slice(0, 4), [...(byPrefix.get(sha.slice(0, 4)) ?? []), sha]);
    const [prefix, shared] = [...byPrefix].find(([, group]) => group.length > 1);
    const run = await resolve(prefix);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`::error::'${prefix}' is ambiguous: it names more than one commit`);
    for (const sha of shared) expect(run.stderr).toContain(`the commit ${sha}`);
  });

  it('fails on a branch and a tag of one name on different commits', async () => {
    const run = await resolve('both');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("::error::'both' is ambiguous: it names more than one commit (the branch both; the tag both).");
  });

  it('refuses an empty ref, and one git could read as an option', async () => {
    expect(await resolve('')).toMatchObject({ code: 1, stderr: expect.stringContaining('::error::The ref is empty.') });
    for (const ref of ['--upload-pack=touch x', '-h', 'main branch']) {
      const run = await resolve(ref);
      expect(run.code, ref).toBe(1);
      expect(run.stderr, ref).toContain(`::error::'${ref}' isn't a branch, tag or commit SHA`);
    }
  });
});
