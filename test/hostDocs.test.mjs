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
// Nor do they promise a GC for the legacy folders: #15 decided on none, and
// scripts/host/legacy-move-aside.sh moves them out instead (v2.0.0, A12).

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

/** A legacy derivative folder, the heartbeat flag about them, or the folders as a group. */
const LEGACY_FOLDER = /\b(?:thumbnails|medium|optimized)(?:-avif)?\b|\blqip\b|\bcache\/|\blegacy[- ]derivatives?\b|\blegacyDerivatives\b/i;

/** A promise that something collects them: GC as a word, case-sensitive so `photos gc` passes. `reclaim` stays out, so "nothing reclaims them" can be said. */
const GC_PROMISE = [/\bGC\b/, /garbage[- ]collect|once it ships/i];

/** Each line that names a legacy folder and promises a GC for it, as `file:line: text`. */
function legacyGcPromises(file, text) {
  return text.split('\n').flatMap((line, index) => (GC_PROMISE.some((promise) => promise.test(line)) && LEGACY_FOLDER.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 160)}`] : []));
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

  it('flag a GC promise for the legacy folders, and leave the move-aside wording alone', () => {
    // The six lines v1.7.0 shipped, as they were, and one more way to say it.
    const flagged = [
      '- **The legacy derivatives** a watcher before v1.7.0 wrote, the seven folders `thumbnails`, `medium`, `optimized`, `thumbnails-avif`, `medium-avif`, `optimized-avif` and `lqip`, and `cache/`, at the top of the library, are left exactly as they are. Nothing writes, reads, or serves them, and the identity scan skips those folder names, so a photo inside them is never taken for one of yours. They harm nothing, so leave them in place: #15\'s GC reclaims them once it ships. No step here moves or deletes them.',
      'A library a watcher before v1.7.0 wrote into still has its legacy derivative folders (`thumbnails`, `medium`, `optimized`, `thumbnails-avif`, `medium-avif`, `optimized-avif`, `lqip`) and `cache/` at the top, often owned by uid 1001. They stay as they are: nothing reads or writes them, the identity scan skips those names, and #15\'s GC reclaims them once it ships. No step moves or deletes them. A host that ran `chown -R 1001:1001` on the photos for an older release can leave that as it is too, since reading is all uid 1001 does now. Every change of owner makes the watcher\'s next identity pass read every photo again, as [Health](#health) says, so don\'t `chown` the library back and forth. If a tool can leave folders out, leave out those eight.',
      '- **The watcher stops writing the legacy derivatives**, the seven `<name>.webp`, `.avif` and `.txt` copies of each photo in `thumbnails/`, `medium/`, `optimized/`, `thumbnails-avif/`, `medium-avif/`, `optimized-avif/` and `lqip/`, and `cache/` beside them, at the top of the library. Nothing has served them since the launch. The ones already there stay exactly as they are, and the identity scan keeps skipping those names. Its heartbeat, `status/watcher.json` in the data root, now says `"legacyDerivatives": false`, which #15\'s GC waits for before it takes legacy files. `--force`, which rebuilt them, exits 2 now.',
      'The legacy derivative folders stay in the library, left as they are. They take space and nothing else, and #15\'s GC reclaims them once it ships. No step of this release, or of any doc here, moves or deletes anything in the library.',
      'The data root needs nothing: `v1.7.0` writes it as `v1.6.x` does, and `v1.6.x`\'s heartbeat simply drops `legacyDerivatives`, which #15\'s GC reads as a watcher that still writes them.',
      'A watcher before v1.7.0 wrote seven resized copies of each photo in this folder\'s top level, in `thumbnails/`, `medium/`, `optimized/`, `thumbnails-avif/`, `medium-avif/`, `optimized-avif/` and `lqip/`, and kept `cache/` beside them. From v1.7.0 nothing writes, reads, or serves them, and the watcher leaves them exactly as they are. The identity scan still skips those eight names at the top level, so nothing in them is ever taken for a photo. They take space and nothing else, so leave them in place: #15\'s GC reclaims them once it ships, and until then a rollback to v1.6.x finds them where its watcher left them. No documented step moves or deletes anything in this folder.',
      'A later garbage collection takes `cache/` too.',
    ];
    for (const text of flagged) expect(legacyGcPromises('probe.md', text), text).not.toEqual([]);
    const allowed = [
      'Nothing in the stack reclaims the legacy derivatives automatically: move them aside with `scripts/host/legacy-move-aside.sh` if you want them out.',
      '`photos gc` cleans the data root only, and never touches `thumbnails/` or any other folder in the library.',
      'GC deletes two kinds of leftover from the data root.',
      'The heartbeat says `"legacyDerivatives": false`. Only the CI smokes and step 4 read it.',
    ];
    for (const text of allowed) expect(legacyGcPromises('probe.md', text), text).toEqual([]);
  });

  // #15 shipped no GC for the legacy folders (v2.0.0, A12): a host step moves them aside instead.
  it.each(HOST_DOCS)('%s promises no GC for the legacy folders', (file) => {
    expect(legacyGcPromises(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))).toEqual([]);
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
