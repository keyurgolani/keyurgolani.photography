// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isHighestRelease, planRelease } from './release-plan.mjs';

// The repository's tags before the first gated release, stray v1.0.0 included.
const TAGS_TODAY = [
  'v0.1.0', 'v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5', 'v0.2.6',
  'v0.3.0', 'v0.3.1', 'v0.4.0', 'v0.4.1', 'v0.4.2', 'v1.0.0',
];

describe('planRelease', () => {
  it('moves latest to a valid tag above every other release tag', () => {
    expect(planRelease({ tag: 'v1.1.0', packageVersion: '1.1.0', tags: [...TAGS_TODAY, 'v1.1.0'] })).toEqual({
      version: 'v1.1.0',
      latest: true,
    });
  });

  it('keeps latest where it is for a tag below the highest release', () => {
    expect(planRelease({ tag: 'v1.1.1', packageVersion: '1.1.1', tags: [...TAGS_TODAY, 'v1.2.0', 'v1.1.1'] })).toEqual({
      version: 'v1.1.1',
      latest: false,
    });
  });

  it('counts the stray v1.0.0 as the highest tag', () => {
    expect(planRelease({ tag: 'v0.5.0', packageVersion: '0.5.0', tags: [...TAGS_TODAY, 'v0.5.0'] }).latest).toBe(false);
    expect(planRelease({ tag: 'v1.1.0', packageVersion: '1.1.0', tags: [...TAGS_TODAY, 'v1.1.0'] }).latest).toBe(true);
  });

  it('keeps latest on a re-run of the highest tag', () => {
    const tags = [...TAGS_TODAY, 'v1.1.0', 'v1.2.0'];
    expect(planRelease({ tag: 'v1.2.0', packageVersion: '1.2.0', tags })).toEqual({ version: 'v1.2.0', latest: true });
  });

  it('never moves latest back when an older tag runs again', () => {
    const tags = [...TAGS_TODAY, 'v1.1.0', 'v1.2.0'];
    expect(planRelease({ tag: 'v1.1.0', packageVersion: '1.1.0', tags }).latest).toBe(false);
  });

  it('refuses a tag that does not match package.json, and says to delete it', () => {
    const refuse = () => planRelease({ tag: 'v1.1.0', packageVersion: '1.0.0', tags: TAGS_TODAY });
    expect(refuse).toThrow('v1.1.0 does not match version 1.0.0 in package.json');
    expect(refuse).toThrow('Delete the v1.1.0 tag, because every vX.Y.Z tag counts when deciding latest.');
  });

  it.each(['v1.2', 'v1.2.0-rc.1', '1.2.0'])('refuses %s, which is not vX.Y.Z', (tag) => {
    expect(() => planRelease({ tag, packageVersion: '1.2.0', tags: TAGS_TODAY })).toThrow(
      `${tag} is not a release tag`,
    );
  });

  it('compares versions numerically, not as strings', () => {
    const tags = ['v0.9.0', 'v0.10.0', 'v1.9.9', 'v1.10.0'];
    expect(isHighestRelease('v1.10.0', tags)).toBe(true);
    expect(isHighestRelease('v1.9.9', tags)).toBe(false);
    expect(isHighestRelease('v0.10.0', ['v0.9.0', 'v0.10.0'])).toBe(true);
    expect(isHighestRelease('v0.9.0', ['v0.9.0', 'v0.10.0'])).toBe(false);
    expect(isHighestRelease('v2.0.0', ['v1.99.99', 'v2.0.0'])).toBe(true);
  });

  it('ignores tags that are not vX.Y.Z when picking the highest', () => {
    const tags = [...TAGS_TODAY, 'v1.1.0', 'v2.0.0-rc.1', 'v9', 'latest'];
    expect(planRelease({ tag: 'v1.1.0', packageVersion: '1.1.0', tags }).latest).toBe(true);
  });
});

describe('release-plan.mjs run directly', () => {
  const script = fileURLToPath(new URL('./release-plan.mjs', import.meta.url));
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const tag = `v${packageVersion}`;
  // Keep the throwaway repositories clear of the user's git config.
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'release-plan test',
    GIT_AUTHOR_EMAIL: 'release-plan@example.invalid',
    GIT_COMMITTER_NAME: 'release-plan test',
    GIT_COMMITTER_EMAIL: 'release-plan@example.invalid',
  };
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-plan-'));
    dirs.push(dir);
    return dir;
  }

  // A repository with one empty commit carrying `tags`. Plumbing commands
  // only, so no hooks or signing settings get involved.
  function repoWithTags(tags) {
    const repo = tempDir();
    const git = (args, input) =>
      execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8', input }).trim();
    git(['-c', 'init.defaultBranch=main', 'init', '-q']);
    const tree = git(['mktree'], '');
    const commit = git(['commit-tree', '--no-gpg-sign', '-m', 'fixture', tree]);
    for (const name of tags) git(['update-ref', `refs/tags/${name}`, commit]);
    return repo;
  }

  function run(refName, cwd) {
    const output = path.join(tempDir(), 'github-output');
    try {
      const stdout = execFileSync(process.execPath, [script], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: output },
      });
      return { status: 0, stdout, outputs: readFileSync(output, 'utf8') };
    } catch (error) {
      return { status: error.status, stdout: error.stdout };
    }
  }

  it('moves latest when the tag is the highest in the repository', () => {
    const result = run(tag, repoWithTags(['v0.0.1', 'v1.2.0-rc.1', tag]));
    expect(result.status).toBe(0);
    expect(result.outputs).toBe(`version=${tag}\nlatest=true\n`);
  });

  it('keeps latest when a higher release tag exists', () => {
    const result = run(tag, repoWithTags([tag, 'v999.0.0']));
    expect(result.status).toBe(0);
    expect(result.outputs).toBe(`version=${tag}\nlatest=false\n`);
  });

  it('exits 1 with the reason for a tag that is not a release tag', () => {
    const result = run('v1.2.0-rc.1', repoWithTags(['v1.2.0-rc.1']));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::v1.2.0-rc.1 is not a release tag');
  });
});
