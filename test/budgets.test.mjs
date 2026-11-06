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

  it('measures on a phone whose screen is its viewport, as image-sizes.spec.ts does', async () => {
    // The project's Desktop Chrome use gives a context a 1920x1080 screen. Under a 390 px phone, Chromium's preload
    // scanner resolves width=device-width to the screen, so the Viewer's preload took w1920 before the page took w1200:
    // 532,480 declared bytes against 400 KiB, a phone no visitor has (CI run 42144161615; B2's 42014654268).
    const spec = await read('e2e/budgets/budgets.spec.ts');
    expect(spec).toContain('const screenOf = (viewport: { width: number; height: number }) => ({ viewport, screen: viewport });');
    const profiles = spec.slice(spec.indexOf('const PROFILES'), spec.indexOf('};', spec.indexOf('const PROFILES')));
    const phone = profiles.match(/^\s+phone: \{(.+)\},$/m)?.[1] ?? '';
    const desktop = profiles.match(/^\s+desktop: \{(.+)\},$/m)?.[1] ?? '';
    expect(phone).toContain('...screenOf({ width: 390, height: 844 })');
    expect(phone).toContain("userAgent: devices['Pixel 7'].userAgent");
    expect(desktop).toContain('...screenOf({ width: 1440, height: 900 })');
    for (const profile of [phone, desktop]) expect(profile).not.toMatch(/\bviewport:/);
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
    // Its own ceiling, so a hang fails the step and the uploads after it still run, inside a job with room for it.
    expect(workflow).toMatch(/- name: Check #6's budgets\n\s+timeout-minutes: 12\n\s+run: npm run test:budgets\n/);
    expect(workflow).toMatch(/\n {2}e2e:\n(?:.*\n)*? {4}timeout-minutes: 55\n/);
    expect(workflow).not.toContain('about 19 minutes');
  });

  it('uploads the report and puts its numbers in the step summary, pass or fail', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    expect(workflow).toMatch(/- if: always\(\)\n\s+name: Summarize #6's budgets\n\s+run: cat \.perf\/report\.md >> "\$GITHUB_STEP_SUMMARY" \|\| true\n/);
    expect(workflow).toMatch(/- if: always\(\)\n\s+uses: actions\/upload-artifact@v7\n\s+with:\n\s+name: budgets-report\n\s+path: \.perf\/report\.json\n\s+if-no-files-found: ignore\n/);
  });

  it('smoke-checks the second bundle in the image, and that photos validate prints budgets from it', async () => {
    const smoke = await read('ci/smoke-watcher-once.sh');
    expect(smoke).toContain('for (const script of ["imageWatcher", "photos", "watcherHealth", "budgets-cli"])');
    expect(smoke).toMatch(/in_watcher node dist\/scripts\/photos\.mjs validate 2>&1/);
    expect(smoke).toContain("'Budgets (gzip'");
  });
});
