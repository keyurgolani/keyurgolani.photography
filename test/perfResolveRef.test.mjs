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
// repository this test makes under os.tmpdir(), and a blob:none clone of it, as the workflow's tool checkout is, both
// left there: it deletes nothing.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'ci', 'perf', 'resolve-ref.sh');
/** This test's own git runs: no global or system config, and nothing that points git at another repository. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(ENV, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
/** Enough commits that some share their first four hex digits. Fixed times, so the SHAs are the same every run. */
const COMMITS = 2000;
/** Loose blobs, none in any commit, so some share a commit's first four hex digits. Fixed contents, as the commits. */
const BLOBS = 3000;
/** The one file on the files branch: in the bare repository, and missing from the blob:none clone. */
const FILE = 'A file the clone never fetched.\n';

let gitDir = '';
let cloneDir = '';
let shas = [];
let blobs = [];
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
  // The local branch the checkout made, behind origin's after a push mid-run: origin's is the branch.
  lines.push('reset refs/heads/feature/fast', 'from :11', '');
  lines.push('reset refs/tags/v1.0.0', 'from :5', '');
  lines.push('tag v2.0.0', 'from :6', 'tagger Fixture <fixture@example.invalid> 1700000000 +0000', 'data 7', 'v2.0.0', '');
  lines.push('reset refs/remotes/origin/both', 'from :8', '', 'reset refs/tags/both', 'from :9', '');
  lines.push('reset refs/remotes/origin/same', 'from :10', '', 'reset refs/tags/same', 'from :10', '');
  for (let n = 1; n <= BLOBS; n += 1) {
    const content = `Fixture blob ${n}\n`;
    lines.push('blob', `mark :${100_000 + n}`, `data ${Buffer.byteLength(content)}`, content);
  }
  lines.push('blob', 'mark :200000', `data ${Buffer.byteLength(FILE)}`, FILE);
  lines.push('commit refs/heads/files', 'mark :200001', 'committer Fixture <fixture@example.invalid> 1700000000 +0000', 'data 5', 'Files', 'M 100644 :200000 file.txt', '');
  execFileSync('git', [`--git-dir=${gitDir}`, 'fast-import', '--quiet', `--export-marks=${gitDir}/fixture-marks`], { env: ENV, input: `${lines.join('\n')}\n` });
  shas = git('rev-list', '--reverse', 'main').split('\n');
  const marks = new Map(fs.readFileSync(`${gitDir}/fixture-marks`, 'utf8').trim().split('\n').map((line) => line.slice(1).split(' ')));
  blobs = Array.from({ length: BLOBS }, (_, n) => marks.get(String(100_001 + n)));
  // As the workflow's tool checkout: every commit and tree, and no blob it didn't ask for.
  git('config', 'uploadpack.allowFilter', 'true');
  cloneDir = path.join(path.dirname(gitDir), 'clone.git');
  execFileSync('git', ['clone', '-q', '--bare', '--filter=blob:none', `file://${gitDir}`, cloneDir], { env: ENV });
});

const commit = (n) => shas[n - 1];

async function resolve(ref, repository = gitDir) {
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', [SCRIPT, repository, ref], { env: ENV });
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
    // origin's, not the local branch that lags it.
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

  it('counts only commits among the objects a short SHA starts: a blob that shares it is no second match', async () => {
    const commitsBy = new Map();
    for (const sha of shas) commitsBy.set(sha.slice(0, 4), [...(commitsBy.get(sha.slice(0, 4)) ?? []), sha]);
    const blob = blobs.find((sha) => commitsBy.get(sha.slice(0, 4))?.length === 1);
    expect(blob, 'a blob that shares its first four hex digits with one commit').toBeDefined();
    const [shared] = commitsBy.get(blob.slice(0, 4));
    expect(await resolve(blob.slice(0, 4))).toEqual({ code: 0, stdout: `${shared}\n`, stderr: '' });
    // A blob's full SHA names no commit.
    expect(await resolve(blob)).toMatchObject({ code: 1, stderr: expect.stringContaining(`::error::No branch, tag or commit is named '${blob}'`) });
  });

  it('never fetches a missing object on demand in a partial clone, and so writes nothing there', async () => {
    const file = git('rev-parse', 'files:file.txt');
    const present = () => {
      try {
        execFileSync('git', [`--git-dir=${cloneDir}`, 'cat-file', '-e', file], { env: { ...ENV, GIT_NO_LAZY_FETCH: '1' }, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    expect(present(), 'the clone starts without the file').toBe(false);
    expect(await resolve('files', cloneDir)).toMatchObject({ code: 0, stdout: `${git('rev-parse', 'files')}\n` });
    expect(await resolve(file, cloneDir)).toMatchObject({ code: 1, stderr: expect.stringContaining(`::error::No branch, tag or commit is named '${file}'`) });
    expect(present(), 'the file is still missing from the clone').toBe(false);
  });

  it('fails on a branch and a tag of one name on different commits', async () => {
    const run = await resolve('both');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("::error::'both' is ambiguous: it names more than one commit (the branch both; the tag both).");
  });

  it('refuses an empty ref, and one git could read as an option, quoting it as the shell would', async () => {
    expect(await resolve('')).toMatchObject({ code: 1, stderr: expect.stringContaining('::error::The ref is empty.') });
    for (const [ref, shown] of [['--upload-pack=touch x', '--upload-pack=touch\\ x'], ['-h', '-h'], ['main branch', 'main\\ branch']]) {
      const run = await resolve(ref);
      expect(run.code, ref).toBe(1);
      expect(run.stderr, ref).toContain(`::error::'${shown}' isn't a branch, tag or commit SHA`);
    }
  });

  it('refuses a name git check-ref-format refuses', async () => {
    for (const ref of ['main..both', 'feature/fast.lock', 'feature/', 'feature//fast', '.hidden', 'feature/.fast', 'main.', '/main']) {
      const run = await resolve(ref);
      expect(run.code, ref).toBe(1);
      expect(run.stdout, ref).toBe('');
      expect(run.stderr, ref).toContain(`::error::'${ref}' isn't a valid branch or tag name`);
    }
  });

  it('keeps a ref with a newline to one ::error:: line, so it can never start a second workflow command', async () => {
    const run = await resolve('main\n::warning::injected');
    expect(run.code).toBe(1);
    const lines = run.stderr.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::error::'\$'main\\n::warning::injected'' isn't a branch, tag or commit SHA/);
  });

  it('takes a branch or a tag by its own name, and says so for a full refs/ name', async () => {
    for (const [ref, name] of [['refs/heads/main', 'main'], ['refs/tags/v1.0.0', 'v1.0.0'], ['refs/remotes/origin/feature/fast', 'feature/fast']]) {
      const run = await resolve(ref);
      expect(run.code, ref).toBe(1);
      expect(run.stderr, ref).toContain(`::error::'${ref}' is a full ref name. Give the branch or tag by its own name, as in '${name}'.`);
    }
  });
});
