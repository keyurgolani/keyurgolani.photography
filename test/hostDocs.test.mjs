// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The host docs never tell the owner to delete anything on or under the photo
// library, his originals: no `rm` on a line, or in a code block, that names
// the library, its paths, or the legacy derivative folders (#13's slice E,
// v1.7.0). The only delete earlier releases' steps keep is of
// ./.next-images-cache, the old /_next/image cache, which is allowed by name.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const HOST_DOCS = [
  'README.md',
  'public/assets/photos/README.md',
  ...fs.readdirSync(path.join(REPO_ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
];

/** A delete command: rm, sudo rm, or find -delete. Docker's --rm flag and `docker rm` of a container aren't. */
const DELETE = /(?:^|[\s;&|(`$])(?:sudo\s+)?rm\s|-delete\b|\bunlink\s|\brmdir\s|\bshred\s/;
const NOT_A_FILE_DELETE = /--rm\b|\bdocker\s+(?:compose\s+\S+\s+)?rm\b|\bcompose\s+rm\b/g;

/** Anything that names the library: its paths, the variable, and the legacy derivative folders, and an aside folder of them. */
const LIBRARY = /public\/assets\/photos|\/data\/library|PHOTOGRAPHY_LIBRARY_DIR|\blibrary\b|(?:^|[\s/'"`])(?:thumbnails|medium|optimized)(?:-avif)?(?:\/|\b)|(?:^|[\s'"`])(?:\.\/)?lqip\b|(?:^|[\s'"`])(?:\.\/)?cache\/|\blegacy[- ]derivatives?\b/i;

/** The one delete earlier releases' steps keep, by name. */
const ALLOWED = /(?:\.\/)?\.next-images-cache\b/g;

const isDelete = (line) => DELETE.test(line.replace(NOT_A_FILE_DELETE, ''));

/** Each line or code block that deletes something and names the library, as `file:line: text`. */
function libraryDeletes(file, text) {
  const found = [];
  const lines = text.split('\n');
  let block = null;
  lines.forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      if (block === null) {
        block = { start: index + 1, lines: [] };
      } else {
        const deletes = block.lines.filter(({ line }) => isDelete(line.replace(ALLOWED, '')));
        const names = block.lines.some(({ line }) => LIBRARY.test(line.replace(ALLOWED, '')));
        if (deletes.length > 0 && names) found.push(`${file}:${block.start}: a code block deletes (${deletes.map(({ line }) => line.trim()).join(' / ')}) and names the library`);
        block = null;
      }
      return;
    }
    if (block !== null) block.lines.push({ line: raw });
    const line = raw.replace(ALLOWED, '');
    if (isDelete(line) && LIBRARY.test(line)) found.push(`${file}:${index + 1}: ${raw.trim().slice(0, 160)}`);
  });
  return found;
}

describe('the host docs', () => {
  it('flag a delete on or under the library, and leave docker --rm and the old image cache alone', () => {
    const flagged = [
      'sudo rm -rf public/assets/photos/optimized',
      '  rm -f -- thumbnails/"$1".webp medium/"$1".webp',
      'Then delete it with `sudo rm -rf legacy-derivatives-<time>`.',
      "docker compose run --rm image-watcher sh -c 'cd /data/library && rm -f x'",
      'find /data/library -name "*.webp" -delete',
      '```bash\ncd public/assets/photos\nrm -rf cache\n```',
    ];
    for (const text of flagged) expect(libraryDeletes('probe.md', text), text).not.toEqual([]);
    const allowed = [
      'docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs identity status',
      'sudo rm -rf ./.next-images-cache',
      'docker rm -f <ID>',
      '```bash\ndocker compose run --rm image-watcher find /data/library -print\n```',
      '```bash\nsudo rm -rf ./.next-images-cache\n```',
    ];
    for (const text of allowed) expect(libraryDeletes('probe.md', text), text).toEqual([]);
  });

  it.each(HOST_DOCS)('%s never suggests deleting anything on or under the library', (file) => {
    expect(libraryDeletes(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))).toEqual([]);
  });
});

describe("the README's screenshots", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const alts = Object.fromEntries([...readme.matchAll(/<img src="(docs\/screenshots\/[^"]+)" alt="([^"]*)"/g)].map(([, src, alt]) => [src, alt]));

  // #12: the alt says what the shot shows, not only which page it is.
  it('describe About with its portrait and statement', () => {
    expect(alts['docs/screenshots/about.png']).toBe('About page with portrait and artist statement');
  });
});
