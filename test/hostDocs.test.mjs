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

// #184: the owner's screen-reader and device pass is a checklist in the accessibility contract, one part per area,
// covering each of #184's acceptance steps, and ending with what to do with a finding.
describe("the accessibility contract's owner pass", () => {
  const contract = fs.readFileSync(path.join(REPO_ROOT, 'docs/accessibility-contract.md'), 'utf8');
  const start = contract.indexOf('\n## The owner\'s screen-reader and device pass\n');
  const rest = start === -1 ? '' : contract.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  const section = next === -1 ? rest : rest.slice(0, next);
  /** Each `### ` part of the section, by its heading, with its text. */
  const parts = Object.fromEntries(
    section
      .split(/\n(?=### )/)
      .slice(1)
      .map((part) => [part.slice(4, part.indexOf('\n')).trim(), part]),
  );
  /** Each checkbox step, with the indented lines under it. */
  const steps = (text) => text.split(/\n(?=\S)/).filter((block) => /^- \[ \] /.test(block));

  it('is one section of the contract', () => {
    expect(start, 'the section heading').not.toBe(-1);
    expect(contract.split("\n## The owner's screen-reader and device pass\n")).toHaveLength(2);
  });

  it('has a part for each area, in order, and every part has checkbox steps', () => {
    const areas = ['Home', 'Site navigation and the theme menu', 'The Viewer', 'Publish', 'The Inbox', 'What to do with a finding'];
    expect(Object.keys(parts)).toEqual(areas);
    for (const area of areas.slice(0, -1)) expect(steps(parts[area]).length, area).toBeGreaterThan(0);
  });

  // Each of #184's acceptance steps, by the words its step can't do without.
  it.each([
    ['Home', /one double-tap/],
    ['Home', /VoiceOver on iOS Safari/],
    ['Home', /TalkBack on Android Chrome/],
    ['Home', /macOS Safari, with a mouse/],
    ['Home', /Enter activates nothing/],
    ['Home', /All bodies of work/],
    ['Home', /"All work"/],
    ['Site navigation and the theme menu', /"Primary"/],
    ['Site navigation and the theme menu', /current page/],
    ['Site navigation and the theme menu', /five/],
    ['Site navigation and the theme menu', /Escape/],
    ['Site navigation and the theme menu', /statement and the count .*again/],
    ['The Viewer', /iPhone Safari/],
    ['The Viewer', /Android Chrome/],
    ['The Viewer', /screen reader off/],
    ['The Viewer', /Zoom/],
    ['The Viewer', /focus/],
    ['The Viewer', /twice/],
    ['The Viewer', /NVDA with Chrome/],
    ['The Viewer', /modal/],
    ['Publish', /group/],
    ['Publish', /collapsed/],
    ['Publish', /review/],
    ['Publish', /live region/],
    ['Publish', /Base moved/],
    ['The Inbox', /filters/],
    ['The Inbox', /detail/],
    ['The Inbox', /error summary/],
    ['The Inbox', /role="alert"/],
    ['What to do with a finding', /bug issue/],
    ['What to do with a finding', /in writing/],
  ])('%s covers %s', (area, words) => {
    expect(parts[area] ?? '', area).toMatch(words);
  });

  it('says what each step should announce, and names no PR', () => {
    for (const line of steps(section)) expect(line, line).toMatch(/Expect|expect/);
    expect(section).not.toMatch(/\b[ABCR]\d{1,2}\b/);
  });
});
