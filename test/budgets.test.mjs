// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `npm run test:budgets` (#6 items 14 and 15): its script, its Playwright
// config on port 3200, the report it writes, and its step in CI's e2e job, so
// a budget regression fails the pull request. Plain JavaScript reading the
// files, as tooling.test.mjs does: lib/ may not import e2e/, which the image
// build drops.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => fs.readFile(path.join(REPO_ROOT, file), 'utf8');

/** The `run:` lines of one job in ci.yml, in order. */
function jobRuns(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`ci.yml has no ${job} job`);
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  const body = end < 0 ? rest : rest.slice(0, end + 1);
  return [...body.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) => match[1].trim());
}

describe('npm run test:budgets', () => {
  it('runs the budgets runner, and fixtures:catalog writes the fixture on its own', async () => {
    const { scripts } = JSON.parse(await read('package.json'));
    expect(scripts['test:budgets']).toBe('tsx e2e/budgets/run.ts');
    expect(scripts['fixtures:catalog']).toBe('tsx e2e/budgets/generate.ts');
  });

  it('serves on 127.0.0.1:3200 from its own config, which the main suite skips', async () => {
    const config = await read('e2e/budgets/budgets.config.ts');
    expect(config).toMatch(/process\.env\.BUDGETS_PORT \|\| '3200'/);
    expect(config).toContain("const host = '127.0.0.1';");
    expect(config).toContain('--hostname ${host} --port ${port}');
    expect(config).toContain('reuseExistingServer: false');
    const main = await read('playwright.config.ts');
    expect(main).toContain("testIgnore: ['**/themes/**', '**/budgets/**']");
    expect(main).toContain("testIgnore: ['**/support/**', '**/themes/**', '**/budgets/**']");
  });

  it('writes .perf/report.json, which Git ignores', async () => {
    expect(await read('.gitignore')).toMatch(/^\/\.perf\/$/m);
    expect(await read('lib/perf/report.ts')).toContain("export const PERF_REPORT_FILE = path.join('.perf', 'report.json');");
  });

  it('runs in CI\'s e2e job right after npm run test:e2e, inside the gate', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    const runs = jobRuns(workflow, 'e2e');
    expect(runs.indexOf('npm run test:budgets')).toBe(runs.indexOf('npm run test:e2e') + 1);
    expect(runs.filter((line) => line === 'npm run test:budgets')).toHaveLength(1);
    // The job is one the CI result needs, so a failed budget fails the pull request.
    expect(workflow).toMatch(/needs: \[[^\]]*\be2e\b[^\]]*\]/);
    // The report goes up with the Playwright report when the job fails.
    expect(workflow).toMatch(/path: \|\n\s+playwright-report\/\n\s+test-results\/\n\s+\.perf\//);
  });
});
