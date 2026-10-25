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
    // web's, and #14's curator, which the Host allowlist holds to 3001.
    expect(prodPublished).toEqual(['127.0.0.1:${PHOTOGRAPHY_PORT:-3000}:3000', '127.0.0.1:3001:3000']);
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
