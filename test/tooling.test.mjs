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
