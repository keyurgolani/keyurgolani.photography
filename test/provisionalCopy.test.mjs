// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ALLOW_PROVISIONAL_COPY lets a production build run on About's placeholder
// copy (utils/artistProfile.ts). It belongs to the Playwright servers only, so
// no image, Compose stack, or workflow may set it.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FLAG = 'ALLOW_PROVISIONAL_COPY';

/** The Dockerfile, every Compose file at the root, and every workflow. */
function shippingFiles() {
  const root = fs.readdirSync(REPO_ROOT).filter((name) => name === 'Dockerfile' || /^docker-compose.*\.ya?ml$/.test(name) || /^compose.*\.ya?ml$/.test(name));
  const workflows = path.join(REPO_ROOT, '.github', 'workflows');
  const flows = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join('.github', 'workflows', name));
  return [...root, ...flows];
}

describe(FLAG, () => {
  it('reads the Dockerfile, the Compose files, and the workflows', () => {
    const files = shippingFiles();
    expect(files).toContain('Dockerfile');
    expect(files).toContain('docker-compose.yml');
    expect(files).toContain(path.join('.github', 'workflows', 'ci.yml'));
  });

  it('is set in none of them', () => {
    const setting = shippingFiles().filter((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').includes(FLAG));
    expect(setting).toEqual([]);
  });
});
