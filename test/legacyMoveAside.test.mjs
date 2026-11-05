// @vitest-environment node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../lib/derivativeFolders.mjs';
import { buildLegacyManifest, sealLegacyManifest, writeLegacyManifest } from '../lib/identity/legacy-derivatives';

// scripts/host/legacy-move-aside.sh (#15, v2.0.0 A12) moves the legacy
// derivative folders a watcher before v1.7.0 wrote out of the photo library,
// to a folder beside it on the same filesystem. It runs on the host, as the
// owner and never as root, against his originals, and a folder's name is
// never enough to move it: on a case-insensitive disk `medium` is also the
// owner's `Medium` album. So it moves only folders the manifest
// `photos legacy-derivatives` writes vouches for, and only while each still
// lists exactly what the manifest holds. These tests run only on temp
// folders: a temp library, a temp data root beside it for the manifest, and a
// temp XDG_STATE_HOME for the used record.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'host', 'legacy-move-aside.sh');
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, 'utf8');
const NAMES = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

const image = (width, format) => sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: '#406080' } })[format]().toBuffer();
const WEBP = [await image(40, 'webp'), await image(64, 'webp')];
const AVIF = [await image(40, 'avif'), await image(64, 'avif')];
const LQIP = `data:image/webp;base64,${WEBP[0].toString('base64')}`;

const roots = [];
/** The test's XDG_STATE_HOME, inside its first temp folder. */
let state = null;
afterEach(() => {
  state = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The tests' own temp folder, 0700 and not sticky: the script refuses a
 * library or destination under a folder others can write, and on Linux CI
 * os.tmpdir() is /tmp, 1777 and sticky.
 */
const TEST_BASE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'keyurgolani-photography-tests');
fs.mkdirSync(TEST_BASE, { recursive: true, mode: 0o700 });
fs.chmodSync(TEST_BASE, 0o700);
for (let dir = path.dirname(fs.realpathSync(TEST_BASE)); ; dir = path.dirname(dir)) {
  const stat = fs.statSync(dir);
  if (stat.mode & 0o022) throw new Error(`${dir}, above the tests' temp root ${TEST_BASE}, is writable by its group or others, so the script would refuse every library under it. Set XDG_CACHE_HOME to a folder only you can write, or run chmod g-w,o-w ${dir}.`);
  if (dir === path.dirname(dir)) break;
}

/** A temp folder for one test's library and data root, resolved so paths compare with the script's. */
function tempRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_BASE, 'legacy-move-aside-')));
  roots.push(root);
  state ??= path.join(root, 'state');
  return root;
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

/** Whether `dir`'s disk finds a name in another case, as APFS does by default. */
function caseInsensitive(dir) {
  const probe = path.join(dir, 'case-probe');
  fs.mkdirSync(probe);
  const insensitive = fs.existsSync(path.join(dir, 'CASE-PROBE'));
  fs.renameSync(probe, path.join(dir, '.case-probe-done'));
  return insensitive;
}

/**
 * A library under `parent` with originals at its root and in a series, and
 * all eight legacy folders as the v1.x pipeline wrote them for the root
 * originals: real WebP and AVIF files, LQIP data URLs, and in `cache/` the
 * old image route's files and the pipeline's set records.
 */
function fullLibrary(parent) {
  const library = path.join(parent, 'photos');
  write(path.join(library, 'a.jpg'), crypto.randomBytes(2048));
  write(path.join(library, 'b.png'), crypto.randomBytes(1024));
  write(path.join(library, 'trip', 'c.jpg'), crypto.randomBytes(1024));
  for (const [folder, extension] of Object.entries(DERIVATIVE_FOLDERS)) {
    ['a', 'b'].forEach((base, n) => {
      const bytes = extension === '.txt' ? LQIP : extension === '.avif' ? AVIF[n] : WEBP[n];
      write(path.join(library, folder, `${base}${extension}`), bytes);
    });
  }
  write(path.join(library, CACHE_FOLDER, 'dynamic', 'a-400-75.webp'), WEBP[0]);
  write(path.join(library, CACHE_FOLDER, 'dynamic', 'b-1920-60.avif'), AVIF[1]);
  write(path.join(library, CACHE_FOLDER, 'set-sources', 'a.json'), '{"source":"a.jpg"}\n');
  write(path.join(library, CACHE_FOLDER, 'set-sources', 'b.json'), '{"source":"b.png","complete":false}\n');
  write(path.join(library, CACHE_FOLDER, 'upright-rebuild.json'), `${JSON.stringify({ rebuiltAt: '2026-01-02T03:04:05.000Z', photos: 2 }, null, 2)}\n`);
  return library;
}

/** Every file and folder under `dir`, as relative path to its digest, or `dir`/`link -> target`. Symlinks aren't followed. */
function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isSymbolicLink()) out[relative] = `link -> ${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        out[relative] = 'dir';
        walk(full);
      } else out[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** tree(), plus each entry's exact name, size and mtime, for the round trip. */
function snapshot(dir) {
  const out = {};
  for (const [relative, digest] of Object.entries(tree(dir))) {
    const stat = fs.lstatSync(path.join(dir, relative), { bigint: true });
    out[relative] = { digest, size: digest === 'dir' ? null : String(stat.size), mtimeNs: String(stat.mtimeNs) };
  }
  return out;
}

/** The real path of a command, before any stub goes on PATH. */
function realBin(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  if (!found.startsWith('/')) throw new Error(`no ${name} on PATH`);
  return found;
}
const BASH = realBin('bash');

/** Runs the script with the test's state folder. An env value of undefined unsets that variable. */
function run(args, env = {}, cwd = undefined) {
  if (state === null) throw new Error('run() needs a tempRoot() first, for XDG_STATE_HOME');
  const merged = { ...process.env, XDG_STATE_HOME: state, ...env };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const result = spawnSync(BASH, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: merged });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A temp data root beside the library, and the manifest for it, as `photos legacy-derivatives` writes it. */
async function manifestFor(library, { clock } = {}) {
  const dataRoot = path.join(path.dirname(library), `data-${path.basename(library)}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  return writeLegacyManifest(dataRoot, await buildLegacyManifest(library, clock ? { clock } : {}));
}

const usedFile = () => path.join(state, 'photos', 'legacy-derivatives.used');

/** Runs the move-back.sh an --apply wrote beside `library`. */
const moveBack = (library, args = []) => spawnSync('sh', [path.join(asideOf(library), 'move-back.sh'), ...args], { encoding: 'utf8' });

/** A heredoc of the script's, as `read -r -d ''` reads it. */
const heredoc = (tag) => SCRIPT_TEXT.match(new RegExp(`<<'${tag}' \\|\\| true\\n([\\s\\S]*?)\\n${tag}\\n`))?.[1];
/** The nsswitch gate, which the script puts ahead of COMMON. */
const NSSWITCH = heredoc('NSSWITCH');
const COMMON = `${NSSWITCH}\n${heredoc('COMMON')}`;
/** The forward rename helper, the one program --rename-as-root sends through sudo. */
const FORWARD = `${COMMON}\n${heredoc('FORWARD')}`;
/** The forward helper after `prelude`, perl that can override a builtin (CORE::GLOBAL) to force one fault at an exact step. */
const forwardWith = (prelude) => `${prelude}\n${COMMON}\n${heredoc('FORWARD')}`;
/** The way back's helper, which move-back.sh carries. */
const BACK = heredoc('BACK');
const digestOf = (manifest) => JSON.parse(fs.readFileSync(manifest, 'utf8')).digest;

/** A sh `case` pattern that matches exactly `file`, which holds no single quote. */
const caseOf = (file) => `'${file}'`;

/**
 * Stubs in a bin folder ahead of PATH. `stat` answers for the paths in
 * `devices` (a device ID), `ids` (a full `dev:inode`) and `statFails`, and
 * passes the rest to the real one. `df` gives the paths in `mounts` a mount
 * of their own. `perl` fails its `perlFailsOn`th rename and runs
 * `beforeRename` (shell) before its first. `id` says `uid`. `sudo` records
 * its arguments and runs `beforeSudo` first, then runs them as this user.
 */
function stubs(root, { devices = {}, ids = {}, statFails = [], mounts = [], perlFailsOn = 0, beforeRename = '', uid = null, sudo = false, beforeSudo = '', afterMkdir = {} } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = (name, body) => {
    write(path.join(bin, name), `#!/bin/sh\n${body}`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  const statCases = [
    ...statFails.map((file) => `  ${caseOf(file)}) exit 1 ;;\n`),
    ...Object.entries(ids).map(([file, id]) => `  ${caseOf(file)}) id='${id}'; dev=\${id%%:*} ;;\n`),
    ...Object.entries(devices).map(([file, device]) => `  ${caseOf(file)}) id='${device}:1'; dev=${device} ;;\n`),
  ].join('');
  stub('stat', `for last; do :; done\ncase "$last" in\n${statCases}  *) exec ${realBin('stat')} "$@" ;;\nesac\ncase "$*" in *%i*) echo "$id" ;; *) echo "$dev" ;; esac\n`);
  const dfCases = mounts.map((file) => `  ${caseOf(file)}) echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "stubfs 1 1 1 1% $last"; exit 0 ;;\n`).join('');
  stub('df', `for last; do :; done\ncase "$last" in\n${dfCases}esac\nexec ${realBin('df')} "$@"\n`);
  const count = path.join(bin, 'rename-calls');
  stub('perl', `case "$2" in *LEGACY_RENAME_HELPER*)\n  n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${count}'\n  if [ "$n" -eq 1 ]; then\n${beforeRename || '    :'}\n  fi\n  if [ "$n" -eq ${perlFailsOn} ]; then echo 'stubbed rename failure' >&2; exit 1; fi ;;\nesac\nexec ${realBin('perl')} "$@"\n`);
  // `afterMkdir` runs a line of shell once mkdir has made the folder it names, as a racing process could.
  const mkdirCases = Object.entries(afterMkdir).map(([dir, line]) => `  ${caseOf(dir)}) ${line} ;;\n`).join('');
  if (mkdirCases) stub('mkdir', `${realBin('mkdir')} "$@" || exit\nfor last; do :; done\ncase "$last" in\n${mkdirCases}esac\n`);
  if (uid !== null) stub('id', `[ "$1" = -u ] && { echo ${uid}; exit 0; }\nexec ${realBin('id')} "$@"\n`);
  // Each call's arguments end in NUL, and each call in \x01, since the helper's code spans lines.
  if (sudo) stub('sudo', `printf '%s\\0' "$@" >> '${path.join(bin, 'sudo-calls')}'; printf '\\001' >> '${path.join(bin, 'sudo-calls')}'\n${beforeSudo}\nexec "$@"\n`);
  const calls = path.join(bin, 'sudo-calls');
  return { PATH: `${bin}:${process.env.PATH}`, sudoCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\x01').filter(Boolean).map((call) => call.split('\0').slice(0, -1)) : []) };
}
const envOf = ({ PATH }) => ({ PATH });

/** A PATH holding links to the given tools only. */
function onlyTools(root, name, tools) {
  const bin = path.join(root, name);
  fs.mkdirSync(bin);
  for (const tool of tools) fs.symlinkSync(realBin(tool), path.join(bin, tool));
  return { PATH: bin };
}
const SCRIPT_TOOLS = ['stat', 'df', 'du', 'awk', 'date', 'dirname', 'basename', 'mkdir', 'cat', 'sed', 'id', 'perl'];

/**
 * Fixture passwd and group files, as the script's test seam
 * (PHOTOS_TEST_PASSWD, PHOTOS_TEST_GROUP) reads them instead of the real
 * databases. `gid` is the group to judge; `others` adds members to it, and
 * `sharing` adds a user whose primary group it is.
 */
function accounts(root, gid, { others = [], sharing = false } = {}) {
  const me = os.userInfo().username;
  const passwd = path.join(root, 'fixture-passwd');
  const group = path.join(root, 'fixture-group');
  fs.writeFileSync(passwd, [`root:x:0:0::/root:/bin/sh`, `${me}:x:${process.getuid()}:${gid}::/home/${me}:/bin/sh`, ...(sharing ? [`visitor:x:${process.getuid() + 7}:${gid}::/home/visitor:/bin/sh`] : [])].join('\n') + '\n');
  fs.writeFileSync(group, [`root:x:0:`, `mine:x:${gid}:${others.join(',')}`].join('\n') + '\n');
  return { PHOTOS_TEST_PASSWD: passwd, PHOTOS_TEST_GROUP: group };
}

/** `text` in single quotes, as the script's quote() and the perl shq() write it. */
const shq = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** `text` as a literal inside a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const asideOf = (library) => `${library}.legacy-derivatives-${today()}`;
const AFTER_APPLY = ['legacy-derivatives.used', 'move-back.sh'];
const idOf = (file) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};

// Each test runs the real script, often several times, so a loaded machine gets 30 s a test.
describe('scripts/host/legacy-move-aside.sh', { timeout: 30_000 }, () => {
  it('names exactly the eight folders lib/derivativeFolders.mjs lists, in its order, in the script and in its helper', () => {
    const list = SCRIPT_TEXT.match(/^NAMES=\(([^)]*)\)/m);
    expect(list, 'a NAMES=(...) line').not.toBeNull();
    expect(list[1].trim().split(/\s+/)).toEqual(NAMES);
    expect(COMMON, 'the shared checks').toBeDefined();
    expect(COMMON.match(/our @EIGHT = qw\(([^)]*)\);/)[1].split(/\s+/)).toEqual(NAMES);
    expect(BACK, 'the way back').toBeDefined();
    expect(BACK.match(/my @eight = qw\(([^)]*)\);/)[1].split(/\s+/)).toEqual(NAMES);
    expect(BACK).not.toContain("'");
  });

  it("keeps the default aside folder out of the image's build context and out of git", () => {
    const lines = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').map((line) => line.trim());
    expect(lines('.dockerignore')).toContain('public/assets/photos.legacy-derivatives-*');
    expect(lines('.gitignore')).toContain('public/assets/photos.legacy-derivatives-*/');
  });

  it('has no delete in it: no rm, unlink, rmdir, shred or find -delete', () => {
    const code = SCRIPT_TEXT.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(code).not.toMatch(/\b(?:rm|unlink|rmdir|shred)\b|-delete\b/);
    // The pattern catches the spellings that dodge a plain `rm `.
    for (const probe of ['\\rm -rf x', '"rm" x', 'command rm x', 'find . -delete']) expect(probe).toMatch(/\b(?:rm|unlink|rmdir|shred)\b|-delete\b/);
  });

  it('exits 2 on a missing library, an unknown flag, or a flag given twice, and moves nothing', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const before = tree(root);
    expect(run([]).status).toBe(2);
    expect(run([library, '--force']).status).toBe(2);
    expect(run([library, '--to']).status).toBe(2);
    expect(run([library, '--to', path.join(root, 'a'), '--to', path.join(root, 'b')]).status).toBe(2);
    expect(run([library, '--manifest', manifest, '--manifest', manifest]).status).toBe(2);
    expect(run([library, library]).status).toBe(2);
    expect(tree(root)).toEqual(before);
  });

  it('refuses to run as root, with nothing written', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const before = tree(root);
    const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { uid: 0 })));
    expect(status).toBe(1);
    expect(stderr).toMatch(/not as root.*Nothing was moved/s);
    const after = tree(root);
    delete after.bin;
    for (const key of Object.keys(after)) if (key.startsWith(`bin${path.sep}`)) delete after[key];
    expect(after).toEqual(before);
  });

  it('is a dry run by default: what moves and what stays, each mv with its size, the total and move-back.sh, and it writes nothing', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    write(path.join(library, 'medium', 'holiday.jpg'), crypto.randomBytes(64));
    const manifest = await manifestFor(library);
    const before = tree(root);
    const { status, stdout, stderr } = run(['--manifest', manifest, library]);
    expect(status, stderr).toBe(0);
    expect(tree(root)).toEqual(before);
    expect(fs.existsSync(state)).toBe(false);
    const dest = asideOf(library);
    expect(fs.existsSync(dest)).toBe(false);
    const moving = NAMES.filter((name) => name !== 'medium');
    for (const name of moving) {
      expect(stdout).toMatch(new RegExp(`^mv ${literal(`'${library}/${name}' '${dest}/${name}'`)} +# [0-9.]+ [kMG]B$`, 'm'));
      expect(stdout).toContain(`mv '${dest}/${name}' '${library}/${name}'`);
    }
    // At a glance: each moving folder with its count and first names, each staying one with why.
    expect(stdout).toMatch(/^Moves aside, 7 folders:$/m);
    expect(stdout).toMatch(/^ {2}thumbnails moves aside: 2 files, such as a\.webp, b\.webp$/m);
    expect(stdout).toMatch(/^ {2}cache moves aside: 5 files, such as dynamic\/a-400-75\.webp, dynamic\/b-1920-60\.avif, set-sources\/a\.json, \.\.\.$/m);
    expect(stdout).toMatch(/^Stays, 1 folder:$/m);
    expect(stdout).toMatch(/^ {2}medium stays: medium\/holiday\.jpg has an original's extension$/m);
    expect(stdout).not.toMatch(/^mv '[^']*\/medium'/m);
    expect(stdout).toMatch(/^Total: 7 folders, [0-9.]+ [kMG]B/m);
    expect(stdout).toMatch(/Dry run: nothing was moved/);
    // One line about root, not the helper's code.
    expect(stdout).not.toMatch(/LEGACY_RENAME_HELPER|use strict|sysopen/);
    expect(stdout).toMatch(/^Nothing runs as root\./m);
  });

  it("says, in the ruling's words, which folders stay because their originals are nested", async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    write(path.join(library, 'medium', 'c.webp'), WEBP[0]);
    const { status, stdout } = run(['--manifest', await manifestFor(library), library]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^ {2}medium stays: its originals are nested, so nothing vouches for it$/m);
  });

  it('--apply moves exactly the eight names, every file byte-identical, records the manifest in the state folder, and its way back puts them back', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const dataBefore = tree(path.dirname(manifest));
    const before = tree(library);
    const { status, stdout, stderr } = run(['--manifest', manifest, '--apply', library]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const dest = asideOf(library);
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', 'trip']);
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
    const moved = Object.fromEntries(Object.entries(before).filter(([relative]) => NAMES.includes(relative.split(path.sep)[0])));
    const aside = tree(dest);
    for (const name of AFTER_APPLY) delete aside[name];
    expect(aside).toEqual(moved);
    expect(tree(library)).toEqual(Object.fromEntries(Object.entries(before).filter(([relative]) => !(relative in moved))));
    // The used record is the owner's, in his state folder, and nothing in the data root changed.
    const digest = JSON.parse(fs.readFileSync(manifest, 'utf8')).digest;
    expect(fs.readFileSync(usedFile(), 'utf8')).toBe(`${digest}\n`);
    expect(fs.statSync(usedFile()).mode & 0o777).toBe(0o600);
    expect(tree(path.dirname(manifest))).toEqual(dataBefore);
    expect(stdout).toContain(`sh '${dest}/move-back.sh'`);
    expect(stdout).not.toMatch(/LEGACY_RENAME_HELPER|use strict/);

    // The way back, as the run says to run it.
    const result = moveBack(library);
    expect(result.status, result.stderr).toBe(0);
    expect(tree(library)).toEqual(before);
    expect(fs.readdirSync(dest).sort()).toEqual(AFTER_APPLY);
  });

  it('round-trips: --apply, then move-back.sh, leaves every name, size, byte and mtime as it was', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    // Times well in the past, so a rewrite would show.
    for (const [relative] of Object.entries(tree(library))) fs.utimesSync(path.join(library, relative), 1_600_000_000, 1_600_000_000 + relative.length);
    const manifest = await manifestFor(library);
    const before = snapshot(library);
    const { status, stdout, stderr } = run(['--manifest', manifest, '--apply', library]);
    expect(status, stderr).toBe(0);
    const file = path.join(asideOf(library), 'move-back.sh');
    expect(stdout).toContain(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    const result = spawnSync('sh', [file], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(library)).toEqual(before);
    // Run twice, it moves nothing more.
    expect(spawnSync('sh', [file], { encoding: 'utf8' }).status).toBe(0);
    expect(snapshot(library)).toEqual(before);
  });

  it("writes a way back that won't move a folder into one the library holds again", async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const { status } = run(['--manifest', await manifestFor(library), '--apply', library]);
    expect(status).toBe(0);
    const dest = asideOf(library);
    // As after restoring a backup made before the move.
    write(path.join(library, 'lqip', 'restored.txt'), 'x');
    const result = moveBack(library);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/lqip exists/);
    expect(fs.readdirSync(path.join(library, 'lqip'))).toEqual(['restored.txt']);
    expect(fs.readdirSync(dest).sort()).toEqual(['lqip', ...AFTER_APPLY].sort());
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', ...NAMES, 'trip'].sort());
  });

  it('leaves a nested thumbnails/, a file named medium, a symlink and an unknown folder where they are', async () => {
    const root = tempRoot();
    const library = path.join(root, 'photos');
    write(path.join(library, 'a.jpg'), crypto.randomBytes(256));
    write(path.join(library, 'trip', 'thumbnails', 'a.webp'), WEBP[0]);
    write(path.join(library, 'medium'), crypto.randomBytes(64));
    write(path.join(root, 'elsewhere', 'a.webp'), WEBP[0]);
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(library, 'optimized'));
    write(path.join(library, 'thumbnails.old', 'a.webp'), WEBP[0]);
    write(path.join(library, 'lqip', 'a.txt'), LQIP);
    const manifest = await manifestFor(library);
    const before = tree(root);
    const { status, stdout, stderr } = run(['--manifest', manifest, '--apply', library]);
    expect(status, stderr).toBe(0);
    const dest = asideOf(library);
    expect(fs.readdirSync(dest).sort()).toEqual(['lqip', ...AFTER_APPLY].sort());
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'medium', 'optimized', 'thumbnails.old', 'trip']);
    const after = tree(root);
    for (const kept of ['photos/trip/thumbnails/a.webp', 'photos/medium', 'photos/optimized', 'photos/thumbnails.old/a.webp', 'elsewhere/a.webp']) {
      expect(after[kept], kept).toBe(before[kept]);
    }
    expect(stdout).toMatch(/medium stays: medium isn't a folder/);
    expect(stdout).toMatch(/optimized stays: optimized is a symlink/);
  });

  it('says so and moves nothing when the library holds none of the names, manifest or not', () => {
    const root = tempRoot();
    const library = path.join(root, 'photos');
    write(path.join(library, 'a.jpg'), crypto.randomBytes(256));
    const before = tree(root);
    const { status, stdout } = run(['--apply', library]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Nothing to move/);
    expect(tree(root)).toEqual(before);
  });

  describe("never touches the owner's own folders", () => {
    /** A library with real legacy folders and `extra` beside them; runs the dry run and --apply, and checks what moved. */
    async function owner(extra) {
      const root = tempRoot();
      const library = path.join(root, 'photos');
      write(path.join(library, 'a.jpg'), crypto.randomBytes(512));
      write(path.join(library, 'thumbnails', 'a.webp'), WEBP[0]);
      write(path.join(library, 'lqip', 'a.txt'), LQIP);
      extra(library);
      const owned = Object.fromEntries(Object.entries(snapshot(library)).filter(([relative]) => !['thumbnails', 'lqip'].includes(relative.split(path.sep)[0])));
      const manifest = await manifestFor(library);
      const dry = run(['--manifest', manifest, library]);
      expect(dry.status, dry.stderr).toBe(0);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library]);
      expect(status, stderr).toBe(0);
      expect(fs.readdirSync(asideOf(library)).sort()).toEqual(['lqip', ...AFTER_APPLY, 'thumbnails'].sort());
      expect(snapshot(library)).toEqual(owned);
      return dry.stdout;
    }

    it('an album named Medium, on a case-insensitive disk', async (ctx) => {
      if (!caseInsensitive(tempRoot())) ctx.skip();
      const stdout = await owner((library) => {
        write(path.join(library, 'Medium', 'portrait.jpg'), crypto.randomBytes(512));
        write(path.join(library, 'Medium', 'a.webp'), WEBP[0]);
      });
      expect(stdout).not.toMatch(/[Mm]edium'/);
    });

    it('an album named Cache, on a case-insensitive disk', async (ctx) => {
      if (!caseInsensitive(tempRoot())) ctx.skip();
      const stdout = await owner((library) => {
        write(path.join(library, 'Cache', 'dynamic', 'a-400-75.webp'), WEBP[0]);
        write(path.join(library, 'Cache', 'street.jpg'), crypto.randomBytes(512));
      });
      expect(stdout).not.toMatch(/[Cc]ache'/);
    });

    it('an album named medium exactly, holding originals', async () => {
      const stdout = await owner((library) => {
        write(path.join(library, 'medium', 'portrait.jpg'), crypto.randomBytes(512));
        write(path.join(library, 'medium', 'a.webp'), WEBP[0]);
      });
      expect(stdout).not.toMatch(/^mv '[^']*\/medium'/m);
      expect(stdout).toMatch(/medium stays: .*has an original's extension/);
    });

    it('an album holding files that look like a marker or a manifest', async () => {
      const stdout = await owner((library) => {
        write(path.join(library, 'optimized', 'a.webp'), WEBP[0]);
        write(path.join(library, 'optimized', 'legacy-derivatives.json'), '{"schemaVersion":1,"folders":[]}');
        write(path.join(library, 'optimized', '.kgp-legacy'), 'legacy');
        write(path.join(library, 'trip', 'legacy-derivatives.json'), '{}');
        write(path.join(library, 'trip', '.kgp-legacy'), 'legacy');
        write(path.join(library, 'trip', 'b.jpg'), crypto.randomBytes(512));
      });
      expect(stdout).not.toMatch(/^mv '[^']*\/optimized'/m);
      expect(stdout).toMatch(/optimized stays: /);
    });

    it.each([
      ['an album by the exact name', 'thumbnails'],
      ['an album by the name in another case', 'Thumbnails'],
    ])('swapped in for a checked folder between the check and its rename: %s', async (_label, albumName) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const album = path.join(root, 'album');
      write(path.join(album, 'portrait.jpg'), crypto.randomBytes(512));
      const albumBefore = snapshot(album);
      const parked = path.join(root, 'parked-thumbnails');
      // Just before the first rename: the checked folder goes, and an album takes its place.
      const env = stubs(root, { beforeRename: `    ${realBin('mv')} '${path.join(library, 'thumbnails')}' '${parked}' && ${realBin('mv')} '${album}' '${path.join(library, albumName)}'` });
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(env));
      expect(status).toBe(1);
      expect(stderr).toMatch(/thumbnails[\s\S]*Nothing further was moved/);
      expect(fs.readdirSync(library)).toContain(albumName);
      expect(snapshot(path.join(library, albumName))).toEqual(albumBefore);
      expect(fs.readdirSync(asideOf(library)).sort()).toEqual(AFTER_APPLY);
    });
  });

  describe('refuses without a good manifest, exits 1 and moves nothing', () => {
    function expectRefused(root, args, pattern, env) {
      const before = tree(root);
      const { status, stdout, stderr } = run(args, env);
      expect(status, stdout + stderr).toBe(1);
      expect(stderr).toMatch(pattern);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(tree(root)).toEqual(before);
    }

    it('when there is none, or no --manifest', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      expectRefused(root, ['--apply', library], /photos legacy-derivatives/);
      expectRefused(root, ['--manifest', path.join(root, 'data', 'status', 'legacy-derivatives.json'), '--apply', library], /photos legacy-derivatives/);
    });

    it('when it is more than 24 hours old', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library, { clock: () => Date.now() - 25 * 60 * 60 * 1000 });
      expectRefused(root, ['--manifest', manifest, '--apply', library], /24 hours.*again/s);
    });

    it('when it was edited after it was written', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const sealed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const body = JSON.parse(sealed.manifest);
      body.folders.push({ name: 'medium', moves: false, reason: 'edited' });
      body.folders[0].files[0].size += 1;
      fs.writeFileSync(manifest, `${JSON.stringify({ ...sealed, manifest: JSON.stringify(body) })}\n`);
      expectRefused(root, ['--manifest', manifest, '--apply', library], /digest/);
    });

    it('when it names another library, with the Docker Desktop hint', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = fullLibrary(path.join(root, 'other'));
      expectRefused(root, ['--manifest', await manifestFor(other), '--apply', library], /another library.*Docker Desktop.*Linux host with a bind mount/s);
    });

    it('when a folder it vouches for changed since', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      write(path.join(library, 'thumbnails', 'new.webp'), WEBP[0]);
      expectRefused(root, ['--manifest', manifest, '--apply', library], /thumbnails changed.*new\.webp/s);
      const other = tempRoot();
      const second = fullLibrary(other);
      const secondManifest = await manifestFor(second);
      fs.utimesSync(path.join(second, 'lqip', 'a.txt'), 1_600_000_000, 1_600_000_000);
      expectRefused(other, ['--manifest', secondManifest, '--apply', second], /lqip changed/);
    });

    it('when it, or any copy of it, was used for an earlier --apply, until it is written again', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const first = run(['--manifest', manifest, '--to', path.join(root, 'aside-1'), '--apply', library]);
      expect(first.status, first.stderr).toBe(0);
      expect(spawnSync('sh', [path.join(root, 'aside-1', 'move-back.sh')], { encoding: 'utf8' }).status).toBe(0);
      expectRefused(root, ['--manifest', manifest, '--to', path.join(root, 'aside-2'), '--apply', library], /used for an earlier --apply.*again/s);
      // A copy of the same manifest elsewhere is the same manifest.
      const copy = path.join(root, 'copy-of-manifest.json');
      fs.copyFileSync(manifest, copy);
      expectRefused(root, ['--manifest', copy, '--to', path.join(root, 'aside-2'), '--apply', library], /used for an earlier --apply/);
      const fresh = await manifestFor(library, { clock: () => Date.now() + 1000 });
      const again = run(['--manifest', fresh, '--to', path.join(root, 'aside-2'), '--apply', library]);
      expect(again.status, again.stderr).toBe(0);
      expect(fs.readdirSync(path.join(root, 'aside-2'))).toContain('thumbnails');
    });

    it('when the used record is a symlink, leaving its target as it was', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const target = path.join(root, 'target.txt');
      write(target, 'not to be written\n');
      fs.mkdirSync(path.dirname(usedFile()), { recursive: true });
      fs.symlinkSync(target, usedFile());
      expectRefused(root, ['--manifest', manifest, '--apply', library], /symlink|plain file/);
      expect(fs.readFileSync(target, 'utf8')).toBe('not to be written\n');
    });

    it('when its copy is inside the library, with nothing written', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const copy = path.join(library, 'trip', 'legacy-derivatives.json');
      fs.copyFileSync(manifest, copy);
      expectRefused(root, ['--manifest', copy, '--apply', library], /manifest .* is inside the library/);
      expect(fs.existsSync(state)).toBe(false);
    });

    it.each([
      ['an original', 'IMG_0001.jpg'],
      ['a RAW file', 'IMG_0001.CR2'],
      ['a derivative of no root original', 'zzz.webp'],
    ])('when a forged, self-sealed manifest vouches for %s in medium/', async (_label, file) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      write(path.join(library, 'IMG_0001.jpg'), crypto.randomBytes(64));
      write(path.join(library, 'medium', file), crypto.randomBytes(64));
      const manifest = await manifestFor(library);
      // The forger writes the listing the live check will see, and seals it himself.
      const body = JSON.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')).manifest);
      const stat = fs.statSync(path.join(library, 'medium', file));
      const medium = body.folders.find((folder) => folder.name === 'medium');
      Object.assign(medium, { moves: true, dirs: [], files: ['a.webp', 'b.webp', file].map((name) => {
        const each = fs.statSync(path.join(library, 'medium', name));
        return { path: name, size: each.size, mtime: Math.floor(each.mtimeMs / 1000) };
      }) });
      delete medium.reason;
      expect(stat.isFile()).toBe(true);
      fs.writeFileSync(manifest, sealLegacyManifest(body));
      expectRefused(root, ['--manifest', manifest, '--apply', library], /vouches for medium\/.* which isn't a file the v1\.x pipeline wrote there/);
    });

    it('when a vouched folder gained a subfolder, empty or not', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      fs.mkdirSync(path.join(library, 'thumbnails', 'new'));
      expectRefused(root, ['--manifest', manifest, '--apply', library], /thumbnails changed[\s\S]*thumbnails\/new\/ is new/);
    });

    it('with no control character, C1 included, reaching the terminal', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      write(path.join(library, 'thumbnails', 'x\u0085\u009by\u0007.webp'), WEBP[0]);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library]);
      expect(status).toBe(1);
      expect(stderr).toContain('thumbnails/x??y?.webp is new');
      expect(stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    });

    it('when it is not one photos legacy-derivatives wrote', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      fs.writeFileSync(manifest, '{"folders":[]}\n');
      expectRefused(root, ['--manifest', manifest, '--apply', library], /isn't one photos legacy-derivatives wrote/);
    });

    it('when the manifest is sealed correctly but names a folder outside the eight', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const body = JSON.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')).manifest);
      body.folders.push({ name: 'trip', moves: true, files: [], dirs: [] });
      fs.writeFileSync(manifest, sealLegacyManifest(body));
      expectRefused(root, ['--manifest', manifest, '--apply', library], /isn't one of the eight/);
    });
  });

  describe('refuses a destination, exits 1 and moves nothing', () => {
    function expectRefused(root, args, pattern, env) {
      const before = tree(root);
      const { status, stdout, stderr } = run(args, env);
      expect(status, stdout + stderr).toBe(1);
      expect(stderr).toMatch(pattern);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(tree(root)).toEqual(before);
    }

    it('inside the library, or the library itself', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      expectRefused(root, [library, '--to', path.join(library, 'aside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(library, 'trip'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', library, '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(library, 'trip', '..', 'aside'), '--apply'], /inside/);
    });

    it('that reaches into the library through a symlink', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(path.join(library, 'trip'), path.join(root, 'looks-outside'));
      expectRefused(root, [library, '--to', path.join(root, 'looks-outside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'looks-outside', 'aside'), '--apply'], /inside/);
    });

    it('inside the real library, given a library reached through a symlink', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(library, path.join(root, 'link'));
      expectRefused(root, [path.join(root, 'link'), '--to', path.join(library, 'aside'), '--apply'], /inside/);
    });

    it('that differs from the library only in case, on a case-insensitive disk', (ctx) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      if (!fs.existsSync(path.join(root, 'PHOTOS'))) ctx.skip();
      expectRefused(root, [library, '--to', path.join(root, 'PHOTOS', 'aside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'PHOTOS'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'Photos', 'Trip'), '--apply'], /inside/);
    });

    it('reached through a symlinked parent', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(root, path.join(root, 'up'));
      expectRefused(root, [library, '--to', path.join(root, 'up', 'photos', 'aside'), '--apply'], /inside/);
    });

    it('whose ancestor stat reports as the library, so only the dev:inode walk can tell', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      const env = envOf(stubs(root, { ids: { [other]: idOf(library) } }));
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /is the library or inside it/, env);
    });

    it('with an ancestor stat can not read', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const deep = path.join(root, 'x', 'y');
      fs.mkdirSync(deep, { recursive: true });
      const env = envOf(stubs(root, { statFails: [path.join(root, 'x')] }));
      expectRefused(root, [library, '--to', path.join(deep, 'aside'), '--apply'], /device and inode of .*\/x\./, env);
    });

    it('inside a checkout, by package.json or next.config.*, the default included, through symlinks too', () => {
      const root = tempRoot();
      write(path.join(root, 'package.json'), '{}');
      const library = fullLibrary(path.join(root, 'public', 'assets'));
      expectRefused(root, [library, '--apply'], /checkout.*--to/s);
      expectRefused(root, [library, '--to', path.join(root, 'public', 'elsewhere'), '--apply'], /outside the checkout/);
      expectRefused(root, [library, '--to', path.join(root, 'aside'), '--apply'], /outside the checkout/);
      const outside = tempRoot();
      fs.symlinkSync(root, path.join(outside, 'looks-outside'));
      expectRefused(root, [library, '--to', path.join(outside, 'looks-outside', 'aside'), '--apply'], /outside the checkout/);
      const configured = tempRoot();
      write(path.join(configured, 'next.config.mjs'), 'export default {};\n');
      const configuredLibrary = fullLibrary(path.join(configured, 'public', 'assets'));
      expectRefused(configured, [configuredLibrary], /checkout/);
    });

    it("but not a host's public/ beside docker-compose.prod.yml", async () => {
      const host = tempRoot();
      write(path.join(host, 'docker-compose.prod.yml'), 'services: {}\n');
      const library = fullLibrary(path.join(host, 'public', 'assets'));
      const { status, stderr } = run(['--manifest', await manifestFor(library), library]);
      expect(status, stderr).toBe(0);
    });

    it('that already holds any of the eight names', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const dest = path.join(root, 'aside');
      write(path.join(dest, 'lqip', 'old.txt'), 'x');
      expectRefused(root, [library, '--to', dest, '--apply'], /already holds lqip/);
      fs.renameSync(path.join(dest, 'lqip'), path.join(root, 'lqip-elsewhere'));
      fs.symlinkSync(path.join(root, 'lqip-elsewhere'), path.join(dest, 'cache'));
      expectRefused(root, [library, '--to', dest, '--apply'], /already holds cache/);
    });

    it('that holds any of the eight, even one the library has no folder for', async () => {
      const root = tempRoot();
      const library = path.join(root, 'photos');
      write(path.join(library, 'a.jpg'), crypto.randomBytes(64));
      write(path.join(library, 'thumbnails', 'a.webp'), WEBP[0]);
      const dest = path.join(root, 'aside');
      write(path.join(dest, 'medium', 'old.webp'), 'x');
      expectRefused(root, ['--manifest', await manifestFor(library), library, '--to', dest, '--apply'], /already holds medium/);
    });

    it('that holds a move-back.sh from an earlier run, and says to pass another --to', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const dest = path.join(root, 'aside');
      write(path.join(dest, 'move-back.sh'), '#!/bin/sh\n');
      expectRefused(root, ['--manifest', await manifestFor(library), library, '--to', dest, '--apply'], /move-back\.sh.*different --to/s);
    });

    it('under a folder its group or others can write, sticky or not, with how to fix it', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      for (const mode of [0o777, 0o775, 0o757, 0o1777, 0o1775]) {
        fs.chmodSync(shared, mode);
        expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], new RegExp(`${literal(shared)} is writable by its group or others[\\s\\S]*chmod g-w,o-w ${literal(shq(shared))}`));
      }
      fs.chmodSync(shared, 0o755);
      const fine = run(['--manifest', manifest, '--to', path.join(shared, 'aside'), library]);
      expect(fine.status, fine.stderr).toBe(0);
    });

    it('lists every folder its group or others can write in one message, with one chmod line', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const outer = path.join(root, 'outer');
      const inner = path.join(outer, 'inner');
      fs.mkdirSync(inner, { recursive: true });
      fs.chmodSync(outer, 0o775);
      fs.chmodSync(inner, 0o757);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(inner, 'aside'), library], new RegExp(`${literal(inner)}, ${literal(outer)} are writable by their group or others[\\s\\S]*chmod g-w,o-w ${literal(shq(inner))} ${literal(shq(outer))}$`, 'm'));
      } finally {
        fs.chmodSync(outer, 0o755);
        fs.chmodSync(inner, 0o755);
      }
    });

    it.each([
      ['refuses a group with a second member', { others: ['visitor'] }, false],
      ['refuses a group that is another user\'s primary group', { sharing: true }, false],
      ['allows your own private group', {}, true],
    ])('for a folder above it that its group can write, %s', async (_label, fixture, allowed) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o775);
      const env = accounts(root, fs.statSync(shared).gid, fixture);
      try {
        if (allowed) {
          const result = run(['--manifest', manifest, '--to', path.join(shared, 'aside'), library], env);
          expect(result.status, result.stderr).toBe(0);
        } else {
          expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], /writable by its group or others[\s\S]*chmod g-w,o-w/, env);
        }
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it('still refuses a folder others can write, even with your own private group', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], /writable by its group or others/, accounts(root, fs.statSync(shared).gid));
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it('on macOS, a library under a folder whose ACL allows others anything', async (ctx) => {
      if (process.platform !== 'darwin') ctx.skip();
      const root = tempRoot();
      const shared = path.join(root, 'acl');
      fs.mkdirSync(shared);
      const library = fullLibrary(shared);
      const manifest = await manifestFor(library);
      expect(spawnSync('chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child', shared]).status).toBe(0);
      expectRefused(root, ['--manifest', manifest, '--to', path.join(root, 'aside'), library], /ACL that allows/);
    });

    it('lists the folders above the library and above the destination in one message, with one chmod line', async () => {
      const root = tempRoot();
      const library = fullLibrary(path.join(root, 'library-parent'));
      const manifest = await manifestFor(library);
      const libraryParent = path.join(root, 'library-parent');
      const asideParent = path.join(root, 'aside-parent');
      fs.mkdirSync(asideParent);
      fs.chmodSync(libraryParent, 0o775);
      fs.chmodSync(asideParent, 0o775);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(asideParent, 'aside'), library], new RegExp(`${literal(libraryParent)}, ${literal(asideParent)} are writable by their group or others[\\s\\S]*^chmod g-w,o-w ${literal(shq(libraryParent))} ${literal(shq(asideParent))}$`, 'm'));
      } finally {
        fs.chmodSync(libraryParent, 0o755);
        fs.chmodSync(asideParent, 0o755);
      }
    });

    it('names a folder above both the library and the destination once', async () => {
      const root = tempRoot();
      const shared = path.join(root, 'shared');
      const library = fullLibrary(path.join(shared, 'library-parent'));
      const manifest = await manifestFor(library);
      fs.chmodSync(shared, 0o775);
      try {
        const { status, stderr } = run(['--manifest', manifest, '--to', path.join(shared, 'aside'), library]);
        expect(status).toBe(1);
        expect(stderr).toContain(`${shared} is writable by its group or others`);
        expect(stderr.split('\n').find((line) => line.startsWith('chmod g-w,o-w '))).toBe(`chmod g-w,o-w ${shq(shared)}`);
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it("quotes each path in the chmod way out, so one with a space and a ' pastes as is", async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const odd = path.join(root, "it's shared");
      fs.mkdirSync(odd);
      fs.chmodSync(odd, 0o775);
      try {
        const { status, stderr } = run(['--manifest', manifest, '--to', path.join(odd, 'aside'), library]);
        expect(status).toBe(1);
        const line = stderr.split('\n').find((each) => each.startsWith('chmod g-w,o-w '));
        expect(line).toBe(`chmod g-w,o-w ${shq(odd)}`);
        // Pasted as printed, it fixes the folder.
        expect(spawnSync('sh', ['-c', line]).status).toBe(0);
        expect(fs.statSync(odd).mode & 0o777).toBe(0o755);
      } finally {
        fs.chmodSync(odd, 0o755);
      }
    });

    it('refuses in the dry run, too, an existing --to that --apply would refuse, with the manifest unused', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const dest = path.join(root, 'aside');
      fs.mkdirSync(dest);
      fs.chmodSync(dest, 0o775);
      // Its group is your private one, so the folders-above rule would let it pass.
      const env = accounts(root, fs.statSync(dest).gid);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', dest, library], new RegExp(`must be yours and writable only by you[\\s\\S]*chmod g-w,o-w ${literal(shq(dest))}`), env);
      } finally {
        fs.chmodSync(dest, 0o755);
      }
      expect(fs.existsSync(state)).toBe(false);
    });

    it.each([
      ['a memberless group that is no one\'s primary group, nor yours', (gid) => ({ passwdGid: gid + 1, groupGid: gid })],
      ['a group the group file has no entry for', (gid) => ({ passwdGid: gid, groupGid: gid + 1 })],
    ])('refuses group write by %s', async (_label, shape) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o775);
      const { passwdGid, groupGid } = shape(fs.statSync(shared).gid);
      const env = accounts(root, groupGid);
      const me = os.userInfo().username;
      fs.writeFileSync(env.PHOTOS_TEST_PASSWD, `root:x:0:0::/root:/bin/sh\n${me}:x:${process.getuid()}:${passwdGid}::/home/${me}:/bin/sh\n`);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], /writable by its group or others/, env);
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it("says so when the account databases couldn't be read in full, and that the test files are in use", async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o775);
      const env = { PHOTOS_TEST_PASSWD: path.join(root, 'no-such-passwd'), PHOTOS_TEST_GROUP: path.join(root, 'no-such-group') };
      try {
        const { status, stderr } = run(['--manifest', manifest, '--to', path.join(shared, 'aside'), library], env);
        expect(status).toBe(1);
        expect(stderr).toMatch(/test account files in use/);
        expect(stderr).toMatch(/the account databases couldn't be read in full \(the test passwd file can't be read\)/i);
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it("on macOS, says group write is refused because the account databases can't be read in full there", async (ctx) => {
      if (process.platform !== 'darwin') ctx.skip();
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o775);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], /couldn't be read in full[\s\S]*macOS/);
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it('a library under a sticky, world-writable folder', async () => {
      const root = tempRoot();
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      const library = fullLibrary(shared);
      const manifest = await manifestFor(library);
      fs.chmodSync(shared, 0o1777);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', path.join(root, 'aside'), library], /writable by its group or others/);
      } finally {
        fs.chmodSync(shared, 0o755);
      }
    });

    it('under a folder owned by someone other than root or you', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      // A stubbed id makes this user someone else, so the temp folders above are another user's.
      const env = envOf(stubs(root, { uid: process.getuid() + 1 }));
      expectRefused(root, ['--manifest', manifest, library], new RegExp(`owned by uid ${process.getuid()}, neither root nor you`), env);
    });

    it('an existing --to that is not yours to write, before anything is written', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const dest = path.join(root, 'aside');
      fs.mkdirSync(dest);
      fs.chmodSync(dest, 0o555);
      try {
        expectRefused(root, ['--manifest', manifest, '--to', dest, '--apply', library], /isn't writable by you/);
      } finally {
        fs.chmodSync(dest, 0o755);
      }
      expect(fs.existsSync(state)).toBe(false);
    });

    it('on macOS, under a folder whose ACL allows others anything', async (ctx) => {
      if (process.platform !== 'darwin') ctx.skip();
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const shared = path.join(root, 'acl');
      fs.mkdirSync(shared);
      expect(spawnSync('chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child', shared]).status).toBe(0);
      expectRefused(root, ['--manifest', manifest, '--to', path.join(shared, 'aside'), library], /ACL that allows/);
    });

    it('inside a data root, by its data-root.json', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const dataRoot = path.dirname(path.dirname(manifest));
      write(path.join(dataRoot, 'data-root.json'), '{"schemaVersion":1}\n');
      expectRefused(root, ['--manifest', manifest, '--to', path.join(dataRoot, 'aside'), library], /inside the data root/);
      expectRefused(root, ['--manifest', manifest, '--to', path.join(dataRoot, 'status', 'aside'), library], /inside the data root/);
    });

    it('that is a file, or whose parent is missing', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      write(path.join(root, 'a-file'), 'x');
      expectRefused(root, [library, '--to', path.join(root, 'a-file'), '--apply'], /isn't a folder/);
      expectRefused(root, [library, '--to', path.join(root, 'no', 'such', 'aside'), '--apply'], /isn't a folder/);
    });

    it('on another device, through a stubbed device check', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = path.join(root, 'other-disk');
      fs.mkdirSync(other);
      const env = envOf(stubs(root, { devices: { [other]: 999999 } }));
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, env);
      expectRefused(root, [library, '--to', path.join(other, 'aside')], /another filesystem/, env);
    });

    it('on another mount of the same device, through a stubbed df', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = path.join(root, 'bind-mount');
      fs.mkdirSync(other);
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, envOf(stubs(root, { mounts: [other] })));
    });

    it('for a legacy folder that is a mount point of its own', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      expectRefused(root, ['--manifest', manifest, '--apply', library], /cache is on another filesystem/, envOf(stubs(root, { devices: { [path.join(library, 'cache')]: 999999 } })));
    });

    it('when a path holds a newline', async () => {
      const root = tempRoot();
      const library = fullLibrary(path.join(root, 'line\nbreak'));
      expectRefused(root, ['--apply', library], /newline/);
      const plain = fullLibrary(path.join(root, 'plain'));
      expectRefused(root, ['--manifest', await manifestFor(plain), '--to', path.join(root, 'aside\nhere'), '--apply', plain], /newline/);
    });

    it('on a host without perl, which the manifest check and the checked renames need', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      expectRefused(root, ['--apply', library], /perl/, onlyTools(root, 'no-perl', SCRIPT_TOOLS.filter((tool) => tool !== 'perl')));
    });
  });

  describe('with --apply', () => {
    it.each([
      ['as the owner', false],
      ['with --rename-as-root, through a stubbed sudo', true],
    ])('works under a umask of 002, %s, making the aside folder 0700', async (_label, asRoot) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const env = asRoot ? envOf(stubs(root, { sudo: true })) : {};
      const previous = process.umask(0o002);
      let result;
      try {
        result = run(['--manifest', manifest, '--apply', ...(asRoot ? ['--rename-as-root'] : []), library], env);
      } finally {
        process.umask(previous);
      }
      expect(result.status, result.stderr).toBe(0);
      const dest = asideOf(library);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
    });

    it('stops at a failed rename, says what moved, and leaves a move-back.sh that undoes just that', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const before = snapshot(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { perlFailsOn: 3 })));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Stopped/);
      expect(stderr).toMatch(/thumbnails medium/);
      expect(stderr).toMatch(/Run photos legacy-derivatives --stdout again/);
      const dest = asideOf(library);
      expect(fs.readdirSync(dest).sort()).toEqual(['medium', ...AFTER_APPLY, 'thumbnails'].sort());
      const result = spawnSync('sh', [path.join(dest, 'move-back.sh')], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(snapshot(library)).toEqual(before);
    });

    it('says the aside folder is safe to leave when the first rename fails', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const before = tree(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { perlFailsOn: 1 })));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(stderr).toMatch(/safe to leave/);
      expect(stderr).not.toMatch(/\b(?:rm|delete|remove)\b/i);
      expect(tree(library)).toEqual(before);
    });

    it('says before writing anything that a read-only library root needs --rename-as-root, and following that advice works', async (ctx) => {
      if (process.getuid?.() === 0) ctx.skip();
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const before = tree(root);
      fs.chmodSync(library, 0o555);
      let dry;
      let apply;
      try {
        dry = run(['--manifest', manifest, library]);
        apply = run(['--manifest', manifest, '--apply', library]);
      } finally {
        fs.chmodSync(library, 0o755);
      }
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toMatch(/needs --rename-as-root, because the library's top folder .* isn't writable by you/);
      expect(apply.status).toBe(1);
      expect(apply.stderr).toMatch(/needs --rename-as-root, because the library's top folder[\s\S]*Nothing was moved/);
      // Refused before anything was written: no dated folder, and the manifest still unused.
      expect(tree(root)).toEqual(before);
      expect(fs.existsSync(state)).toBe(false);
      // The advice, word for word: the same command with --rename-as-root. The stubbed sudo stands in for root.
      const advised = apply.stderr.match(/run it again with (--rename-as-root)/);
      expect(advised).not.toBeNull();
      fs.chmodSync(library, 0o555);
      let elevated;
      try {
        elevated = run(['--manifest', manifest, '--apply', advised[1], library], envOf(stubs(root, { sudo: true, beforeSudo: `chmod 755 '${library}'` })));
      } finally {
        fs.chmodSync(library, 0o755);
      }
      expect(elevated.status, elevated.stderr).toBe(0);
      expect(fs.readdirSync(asideOf(library)).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
    });

    it("says a folder that isn't writable by you needs --rename-as-root, for its .. entry", async (ctx) => {
      if (process.getuid?.() === 0) ctx.skip();
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const folder = path.join(library, 'medium');
      fs.chmodSync(folder, 0o555);
      let apply;
      try {
        apply = run(['--manifest', manifest, '--apply', library]);
      } finally {
        fs.chmodSync(folder, 0o755);
      }
      expect(apply.status).toBe(1);
      expect(apply.stderr).toMatch(/needs --rename-as-root, because .*\/medium isn't writable by you, and moving a folder to a new parent rewrites its \.\. entry/);
      expect(fs.existsSync(asideOf(library))).toBe(false);
    });

    it('with --rename-as-root, runs only the forward helper through sudo, by absolute path in a clean env', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const stub = stubs(root, { sudo: true });
      const { status, stdout, stderr } = run(['--manifest', manifest, '--apply', '--rename-as-root', library], envOf(stub));
      expect(status, stderr).toBe(0);
      const dest = asideOf(library);
      const calls = stub.sudoCalls();
      expect(calls).toHaveLength(8);
      calls.forEach((call, n) => {
        expect(call).toEqual(['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `SUDO_UID=${process.getuid()}`, '/usr/bin/perl', '-e', FORWARD, '--', 'forward', manifest, library, dest, NAMES[n]]);
      });
      expect(stdout).toMatch(/^Only the rename helper runs as root, through sudo, once a folder\./m);
      expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
      // Nothing else ran as root: the way back and the used record are the owner's.
      expect(fs.statSync(path.join(dest, 'move-back.sh')).uid).toBe(process.getuid());
      expect(fs.statSync(usedFile()).uid).toBe(process.getuid());
    });

    it('with --rename-as-root, a swap between the check and the elevated rename is refused by the helper', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const album = path.join(root, 'album');
      write(path.join(album, 'portrait.jpg'), crypto.randomBytes(512));
      const albumBefore = snapshot(album);
      const marker = path.join(root, 'swapped');
      const stub = stubs(root, { sudo: true, beforeSudo: `[ -e '${marker}' ] || { : > '${marker}'; ${realBin('mv')} '${path.join(library, 'thumbnails')}' '${path.join(root, 'parked')}'; ${realBin('mv')} '${album}' '${path.join(library, 'thumbnails')}'; }` });
      const { status, stderr } = run(['--manifest', manifest, '--apply', '--rename-as-root', library], envOf(stub));
      expect(status).toBe(1);
      expect(stderr).toMatch(/thumbnails[\s\S]*Nothing further was moved/);
      expect(snapshot(path.join(library, 'thumbnails'))).toEqual(albumBefore);
      expect(fs.readdirSync(asideOf(library)).sort()).toEqual(AFTER_APPLY);
    });

    it('refuses before the manifest is spent when the dated folder comes out writable by its group', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const dest = asideOf(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { afterMkdir: { [dest]: `chmod 0775 '${dest}'` } })));
      expect(status).toBe(1);
      expect(stderr).toMatch(/still unused/);
      expect(fs.existsSync(usedFile())).toBe(false);
      expect(fs.readdirSync(dest)).toEqual([]);
      expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', ...NAMES, 'trip'].sort());
    });

    it("runs the helper without the test account files, even when the host's environment has them", async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const leak = path.join(root, 'seam-leaked');
      const env = { ...envOf(stubs(root, { beforeRename: `    [ -z "\${PHOTOS_TEST_PASSWD+x}\${PHOTOS_TEST_GROUP+x}" ] || : > '${leak}'` })), ...accounts(root, process.getgid()) };
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], env);
      expect(status, stderr).toBe(0);
      expect(fs.existsSync(leak)).toBe(false);
    });

    it('never follows a link put where move-back.sh goes, just after the dated folder is made', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const target = path.join(root, 'target.txt');
      write(target, 'untouched\n');
      const dest = asideOf(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { afterMkdir: { [dest]: `ln -s '${target}' '${dest}/move-back.sh'` } })));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Can't write .*move-back\.sh/);
      expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
      expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', ...NAMES, 'trip'].sort());
      // The used record went first, so this manifest is spent.
      expect(fs.readFileSync(usedFile(), 'utf8')).toBe(`${digestOf(manifest)}\n`);
    });

    it('never follows a link raced in where the used record goes, just after the state folder is made', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const target = path.join(root, 'target.txt');
      write(target, 'untouched\n');
      const photos = path.join(state, 'photos');
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], envOf(stubs(root, { afterMkdir: { [photos]: `ln -s '${target}' '${photos}/legacy-derivatives.used'` } })));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Can't record the manifest as used[\s\S]*still unused/);
      expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
      expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', ...NAMES, 'trip'].sort());
      // The aside folder comes first now, 0700 and checked, and nothing went into it.
      expect(fs.readdirSync(asideOf(library))).toEqual([]);
    });
  });

  describe('the forward helper, which may run as root, works everything out itself', () => {
    /** A library, its manifest, and an aside folder as the owner's phase leaves it: move-back.sh and the used record. */
    async function setUp() {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const aside = path.join(root, 'aside');
      fs.mkdirSync(aside, { mode: 0o755 });
      fs.chmodSync(aside, 0o755);
      write(path.join(aside, 'move-back.sh'), '#!/bin/sh\n');
      write(path.join(aside, 'legacy-derivatives.used'), `${digestOf(manifest)}\n`);
      const ok = ['forward', manifest, library, aside, 'thumbnails'];
      return { root, library, manifest, aside, ok };
    }
    const helper = (args, env = {}) => spawnSync(realBin('perl'), ['-e', FORWARD, '--', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '', ...env } });

    function expectHelperRefused(root, args, pattern, env) {
      const before = tree(root);
      const result = helper(args, env);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(pattern);
      expect(result.stderr).toMatch(/Nothing further was moved/);
      expect(tree(root)).toEqual(before);
    }

    it('refuses an aside folder inside the library, though it holds the right files', async () => {
      const { root, library, manifest, ok } = await setUp();
      const inside = path.join(library, 'trip');
      write(path.join(inside, 'move-back.sh'), '#!/bin/sh\n');
      write(path.join(inside, 'legacy-derivatives.used'), `${digestOf(manifest)}\n`);
      const args = [...ok];
      args[3] = inside;
      expectHelperRefused(root, args, /inside the library/);
    });

    it("refuses an unrelated folder that isn't an aside folder this manifest made", async () => {
      const { root, manifest, ok } = await setUp();
      const unrelated = path.join(root, 'unrelated');
      fs.mkdirSync(unrelated);
      const args = [...ok];
      args[3] = unrelated;
      expectHelperRefused(root, args, /move-back\.sh/);
      write(path.join(unrelated, 'move-back.sh'), '#!/bin/sh\n');
      write(path.join(unrelated, 'legacy-derivatives.used'), 'sha256:another\n');
      expectHelperRefused(root, args, /doesn't hold this manifest's digest/);
      expect(manifest).toBeTruthy();
    });

    it('refuses folders above the library or the aside folder owned by someone other than root or SUDO_UID', async () => {
      const { root, ok } = await setUp();
      expectHelperRefused(root, ok, new RegExp(`owned by uid ${process.getuid()}, neither root nor uid ${process.getuid() + 1}`), { SUDO_UID: String(process.getuid() + 1) });
    });

    it('refuses a relative library or aside folder, which would mean something else inside the library', async () => {
      const { root, library, aside, ok } = await setUp();
      // An owner album by the aside folder's name, inside the library: where a relative "aside" would land after chdir.
      write(path.join(library, 'aside', 'portrait.jpg'), crypto.randomBytes(64));
      const before = tree(root);
      const relative = [...ok];
      relative[3] = path.basename(aside);
      const result = spawnSync(realBin('perl'), ['-e', FORWARD, '--', ...relative], { encoding: 'utf8', cwd: root, env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(/isn't an absolute path/);
      expect(tree(root)).toEqual(before);
      const relativeLibrary = [...ok];
      relativeLibrary[2] = path.basename(library);
      const second = spawnSync(realBin('perl'), ['-e', FORWARD, '--', ...relativeLibrary], { encoding: 'utf8', cwd: root, env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(second.status, second.stderr).toBe(3);
      expect(second.stderr).toMatch(/isn't an absolute path/);
    });

    /** A library and an aside folder under parents of their own, so each guard on the folders above can be pinned alone. */
    async function apart() {
      const root = tempRoot();
      const library = fullLibrary(path.join(root, 'library-parent'));
      const manifest = await manifestFor(library);
      const aside = path.join(root, 'aside-parent', 'aside');
      fs.mkdirSync(aside, { recursive: true });
      fs.chmodSync(aside, 0o755);
      write(path.join(aside, 'move-back.sh'), '#!/bin/sh\n');
      write(path.join(aside, 'legacy-derivatives.used'), `${digestOf(manifest)}\n`);
      return { root, library, aside, ok: ['forward', manifest, library, aside, 'thumbnails'] };
    }

    it('renames into the resolved aside folder, not the path it was given', async () => {
      const { root, aside, ok } = await apart();
      fs.symlinkSync(path.join(root, 'aside-parent'), path.join(root, 'by-link'));
      const given = path.join(root, 'by-link', 'aside');
      const prelude = String.raw`BEGIN { *CORE::GLOBAL::rename = sub ($$) { print STDERR "RENAME $_[0] -> $_[1]\n"; CORE::rename($_[0], $_[1]) } }`;
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(prelude), '--', 'forward', ok[1], ok[2], given, 'thumbnails'], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(`RENAME thumbnails -> ${aside}/thumbnails`);
    });

    it("refuses a folder above it that can't be read", async () => {
      const { root, ok } = await apart();
      const parent = path.join(root, 'library-parent');
      const prelude = String.raw`BEGIN { *CORE::GLOBAL::lstat = sub (;*) { my $path = @_ ? $_[0] : $_; return if $path eq '${parent}'; my @s = CORE::lstat($path); return wantarray ? @s : scalar @s } }`;
      const before = tree(root);
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(prelude), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(new RegExp(`Can't read ${literal(parent)}`));
      expect(tree(root)).toEqual(before);
    });

    it('refuses a folder above the library only that its group can write', async () => {
      const { root, ok } = await apart();
      fs.chmodSync(path.join(root, 'library-parent'), 0o775);
      try {
        expectHelperRefused(root, ok, new RegExp(`${literal(path.join(root, 'library-parent'))} is writable by its group or others`));
      } finally {
        fs.chmodSync(path.join(root, 'library-parent'), 0o755);
      }
    });

    it('refuses a folder above the aside folder only that its group can write', async () => {
      const { root, ok } = await apart();
      fs.chmodSync(path.join(root, 'aside-parent'), 0o775);
      try {
        expectHelperRefused(root, ok, new RegExp(`${literal(path.join(root, 'aside-parent'))} is writable by its group or others`));
      } finally {
        fs.chmodSync(path.join(root, 'aside-parent'), 0o755);
      }
    });

    it.each([
      ['refuses a group with a second member', { others: ['visitor'] }, false],
      ["refuses a group that is another user's primary group", { sharing: true }, false],
      ['allows your own private group', {}, true],
    ])('for a folder above the library that its group can write, %s', async (_label, fixture, allowed) => {
      const { root, library, aside, ok } = await apart();
      const parent = path.join(root, 'library-parent');
      fs.chmodSync(parent, 0o775);
      const env = accounts(root, fs.statSync(parent).gid, fixture);
      try {
        if (allowed) {
          const result = helper(ok, env);
          expect(result.status, result.stderr).toBe(0);
          expect(fs.existsSync(path.join(library, 'thumbnails'))).toBe(false);
          expect(fs.readdirSync(path.join(aside, 'thumbnails')).sort()).toEqual(['a.webp', 'b.webp']);
        } else {
          expectHelperRefused(root, ok, /writable by its group or others/, env);
        }
      } finally {
        fs.chmodSync(parent, 0o755);
      }
    });

    it('on macOS, refuses a folder above the library whose ACL allows others anything', async (ctx) => {
      if (process.platform !== 'darwin') ctx.skip();
      const { root, ok } = await apart();
      expect(spawnSync('chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child', path.join(root, 'library-parent')]).status).toBe(0);
      expectHelperRefused(root, ok, /ACL that allows/);
    });

    it('refuses an aside folder its group or others can write, and says how to fix it', async () => {
      const { root, aside, ok } = await setUp();
      for (const mode of [0o775, 0o757, 0o1777]) {
        fs.chmodSync(aside, mode);
        expectHelperRefused(root, ok, new RegExp(`${literal(aside)} is writable by its group or others[\\s\\S]*chmod g-w,o-w ${literal(shq(aside))}`));
      }
    });

    it('refuses SUDO_UID 0, so root never stands in for the owner', async () => {
      const { root, ok } = await setUp();
      expectHelperRefused(root, ok, /SUDO_UID isn't a user's uid/, { SUDO_UID: '0' });
    });

    it('checks the manifest\'s age itself', async () => {
      const { root, library, aside } = await setUp();
      const stale = await manifestFor(library, { clock: () => Date.now() - 25 * 60 * 60 * 1000 });
      fs.writeFileSync(path.join(aside, 'legacy-derivatives.used'), `${digestOf(stale)}\n`);
      expectHelperRefused(root, ['forward', stale, library, aside, 'thumbnails'], /more than 24 hours old/);
    });

    it.each([
      ['move-back.sh as a hard link', (aside, root) => fs.linkSync(path.join(aside, 'move-back.sh'), path.join(root, 'second-link'))],
      ['move-back.sh as a symlink', (aside, root) => {
        fs.renameSync(path.join(aside, 'move-back.sh'), path.join(root, 'real-move-back.sh'));
        fs.symlinkSync(path.join(root, 'real-move-back.sh'), path.join(aside, 'move-back.sh'));
      }],
      ['the used record as a hard link', (aside, root) => fs.linkSync(path.join(aside, 'legacy-derivatives.used'), path.join(root, 'second-record'))],
    ])("refuses the aside folder's own files when they aren't plain files with one link: %s", async (_label, change) => {
      const { root, aside, ok } = await setUp();
      change(aside, root);
      expectHelperRefused(root, ok, /isn't a plain file of yours with one link/);
    });

    it("refuses an aside folder on another device than the library's", async () => {
      const { root, aside, ok } = await setUp();
      const prelude = String.raw`BEGIN { *CORE::GLOBAL::lstat = sub (;*) { my $path = @_ ? $_[0] : $_; my @s = CORE::lstat($path); $s[0] += 1 if @s && $path eq '${aside}'; return wantarray ? @s : scalar @s } }`;
      const before = tree(root);
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(prelude), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(/isn't on the library's device/);
      expect(tree(root)).toEqual(before);
    });

    /** A prelude that hides `thumbnails` from readdir only on the handle opened on `where`. */
    const hideFrom = (where) => String.raw`my %dir_of;
BEGIN {
  *CORE::GLOBAL::opendir = sub (*$) { my $ok = CORE::opendir($_[0], $_[1]); $dir_of{"$_[0]"} = $_[1] if $ok; return $ok };
  *CORE::GLOBAL::readdir = sub (*) { my @entries = CORE::readdir($_[0]); return ($dir_of{"$_[0]"} // '') eq '${where}' ? grep { $_ ne 'thumbnails' } @entries : @entries };
}`;

    it('stops at the root listing when it no longer lists the name exactly, on its own', async () => {
      const { root, library, ok } = await setUp();
      const before = tree(root);
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(hideFrom(library)), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(/no entry named exactly thumbnails now, so it changed since the check/);
      expect(tree(root)).toEqual(before);
    });

    it('stops at the last fresh listing, right before the rename, on its own', async () => {
      const { root, ok } = await setUp();
      const before = tree(root);
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(hideFrom('.')), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(/no entry named exactly thumbnails right before the rename/);
      expect(tree(root)).toEqual(before);
    });

    it('refuses a library path swapped for a symlink to another library between the check and the rename', async () => {
      const { root, library, ok } = await setUp();
      const other = fullLibrary(path.join(root, 'other'));
      const prelude = String.raw`BEGIN { *CORE::GLOBAL::chdir = sub (;$) { my $to = $_[0]; if ($to eq '${library}' && !$main::swapped++) { CORE::rename('${library}', '${library}.real'); symlink('${other}', '${library}') } return CORE::chdir($to) } }`;
      const result = spawnSync(realBin('perl'), ['-e', forwardWith(prelude), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toMatch(/isn't the library the check saw/);
      expect(fs.readdirSync(`${library}.real`)).toContain('thumbnails');
      expect(fs.readdirSync(other)).toContain('thumbnails');
    });

    /** A prelude that, right after the forward rename succeeds, runs `perl` once, in the library. */
    const afterRename = (perl) => String.raw`BEGIN { *CORE::GLOBAL::rename = sub ($$) { my ($from, $to) = @_; my $ok = CORE::rename($from, $to); if ($ok && $from eq 'thumbnails' && !$main::done++) { ${perl} } return $ok } }`;
    const runAfterRename = (ok, perl) => spawnSync(realBin('perl'), ['-e', forwardWith(afterRename(perl)), '--', ...ok], { encoding: 'utf8', env: { PATH: process.env.PATH, SUDO_UID: '' } });

    it('renames straight back when what arrived is not the checked folder', async () => {
      const { library, aside, ok } = await setUp();
      const result = runAfterRename(ok, String.raw`CORE::rename('${aside}/thumbnails', '${aside}/moved-away'); mkdir '${aside}/thumbnails';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/wasn't the folder that was checked, so it was moved straight back/);
      expect(fs.readdirSync(path.join(library, 'thumbnails'))).toEqual([]);
      expect(fs.existsSync(path.join(aside, 'thumbnails'))).toBe(false);
    });

    it('leaves it where it is, rather than move it straight back, when the aside folder changed', async () => {
      const { library, aside, ok } = await setUp();
      const result = runAfterRename(ok, String.raw`CORE::rename('${aside}', '${aside}-old'); mkdir '${aside}'; mkdir '${aside}/thumbnails';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/aside folder .* changed[\s\S]*left where it is/);
      expect(fs.existsSync(path.join(library, 'thumbnails'))).toBe(false);
      expect(fs.readdirSync(path.join(`${aside}-old`, 'thumbnails')).sort()).toEqual(['a.webp', 'b.webp']);
    });

    it('leaves it where it is, rather than move it straight back, when the library holds the name again, in any case', async () => {
      const { library, aside, ok } = await setUp();
      const result = runAfterRename(ok, String.raw`CORE::rename('${aside}/thumbnails', '${aside}/moved-away'); mkdir '${aside}/thumbnails'; mkdir 'Thumbnails';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/holds thumbnails again[\s\S]*left where it is/);
      expect(fs.readdirSync(library)).toContain('Thumbnails');
      expect(fs.readdirSync(path.join(library, 'Thumbnails'))).toEqual([]);
      expect(fs.readdirSync(path.join(aside, 'thumbnails'))).toEqual([]);
    });

    it('refuses a name the manifest says stays, or that is not one of the eight', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      write(path.join(library, 'medium', 'portrait.jpg'), crypto.randomBytes(64));
      const manifest = await manifestFor(library);
      const aside = path.join(root, 'aside');
      fs.mkdirSync(aside);
      fs.chmodSync(aside, 0o755);
      write(path.join(aside, 'move-back.sh'), '#!/bin/sh\n');
      write(path.join(aside, 'legacy-derivatives.used'), `${digestOf(manifest)}\n`);
      expectHelperRefused(root, ['forward', manifest, library, aside, 'medium'], /manifest doesn't move medium/);
      for (const name of ['Thumbnails', 'trip', '../trip']) expectHelperRefused(root, ['forward', manifest, library, aside, name], /not one of the eight/);
    });

    it('refuses a library path that is not the library the manifest names', async () => {
      const { root, ok } = await setUp();
      const other = fullLibrary(path.join(root, 'other'));
      const args = [...ok];
      args[2] = other;
      expectHelperRefused(root, args, /not the library the manifest names/);
    });

    it('refuses a folder whose name the library no longer lists exactly, even where the disk would find it', async () => {
      const { root, library, ok } = await setUp();
      fs.renameSync(path.join(library, 'thumbnails'), path.join(library, 'thumbnails-moving'));
      fs.renameSync(path.join(library, 'thumbnails-moving'), path.join(library, 'Thumbnails'));
      expectHelperRefused(root, ok, /no entry named exactly thumbnails/);
    });

    it('re-checks the live listing against the manifest, as root, after any wait for a password', async () => {
      const { root, library, ok } = await setUp();
      write(path.join(library, 'thumbnails', 'IMG_0001.jpg'), crypto.randomBytes(64));
      expectHelperRefused(root, ok, /thumbnails changed[\s\S]*IMG_0001\.jpg is new/);
    });

    it('refuses a destination that already exists', async () => {
      const { root, aside, ok } = await setUp();
      fs.mkdirSync(path.join(aside, 'thumbnails'));
      expectHelperRefused(root, ok, /exists/);
    });

    it('moves the folder when every check holds', async () => {
      const { library, aside, ok } = await setUp();
      const result = helper(ok);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(library, 'thumbnails'))).toBe(false);
      expect(fs.readdirSync(path.join(aside, 'thumbnails')).sort()).toEqual(['a.webp', 'b.webp']);
    });
  });

  describe("the README's manual way back", () => {
    const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    /** The documented line that starts with `[ ! -e "$library/$name" ]` and ends in `mv <flag>`. */
    const documented = (flag) => README.split('\n').map((line) => line.trim()).find((line) => line.startsWith('[ ! -e "$library/$name" ]') && line.includes(`&& mv ${flag} "$aside/$name" "$library/$name" ||`));
    const gnuMv = spawnSync('mv', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU') ?? false;

    function tryIt(line, album) {
      const root = tempRoot();
      const library = path.join(root, 'photos');
      const aside = path.join(root, 'aside');
      write(path.join(aside, 'thumbnails', 'a.webp'), WEBP[0]);
      if (album) write(path.join(library, album, 'portrait.jpg'), crypto.randomBytes(64));
      else fs.mkdirSync(library, { recursive: true });
      const before = snapshot(root);
      const result = spawnSync('sh', ['-c', `aside='${aside}'; library='${library}'; name=thumbnails\n${line}`], { encoding: 'utf8' });
      return { root, library, aside, before, result };
    }

    it.each([['-n'], ['-nT']])('documents a form with mv %s', (flag) => {
      expect(documented(flag), `a README line ending in mv ${flag}`).toBeDefined();
      expect(documented(flag)).toContain('grep -Fixq');
      expect(documented(flag)).toMatch(/\|\| echo "Not moved: \$name is taken or the check failed"$/);
    });

    it.each([['an album by the same name in another case', 'Thumbnails'], ['an album by the same name', 'thumbnails']])('with mv -n, never nests into %s, and says so', (_label, album) => {
      const { root, before, result } = tryIt(documented('-n'), album);
      expect(result.stdout).toMatch(/Not moved: thumbnails is taken or the check failed/);
      expect(snapshot(root)).toEqual(before);
    });

    it('with mv -n, moves the folder back when the name is clear', () => {
      const { library, aside, result } = tryIt(documented('-n'), null);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toMatch(/Not moved/);
      expect(fs.readdirSync(library)).toEqual(['thumbnails']);
      expect(fs.readdirSync(aside)).toEqual([]);
    });

    // Skipped where mv isn't GNU coreutils, which -T needs, as on macOS; CI's Linux runner has it.
    it.skipIf(!gnuMv).each([['Thumbnails'], ['thumbnails']])('with GNU mv -nT, never nests into %s', (album) => {
      const { root, before, result } = tryIt(documented('-nT'), album);
      expect(result.stdout).toMatch(/Not moved: thumbnails is taken or the check failed/);
      expect(snapshot(root)).toEqual(before);
    });
  });

  it('reads the account databases once, and keeps that result even when the read failed', () => {
    const root = tempRoot();
    const gid = process.getgid();
    const env = accounts(root, gid);
    const staged = `${env.PHOTOS_TEST_PASSWD}.staged`;
    fs.renameSync(env.PHOTOS_TEST_PASSWD, staged);
    const program = `${COMMON}\nprint private_group($ARGV[0], $ARGV[1]) ? 1 : 0; rename($ARGV[2], $ENV{PHOTOS_TEST_PASSWD}) or die; print private_group($ARGV[0], $ARGV[1]) ? 1 : 0;`;
    const result = spawnSync(realBin('perl'), ['-e', program, '--', String(gid), String(process.getuid()), staged], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('00');
    // With the file back, a fresh run finds the private group, so the 0 above was the cached failure.
    const fresh = spawnSync(realBin('perl'), ['-e', `${COMMON}\nprint private_group($ARGV[0], $ARGV[1]) ? 1 : 0;`, '--', String(gid), String(process.getuid())], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    expect(fresh.stdout).toBe('1');
  });

  describe('the nsswitch gate', () => {
    const gate = (text) => {
      const root = tempRoot();
      const file = path.join(root, 'nsswitch.conf');
      fs.writeFileSync(file, text);
      return spawnSync(realBin('perl'), ['-e', `${NSSWITCH}\nprint nss_problem($ARGV[0]);`, '--', file], { encoding: 'utf8' }).stdout;
    };

    it('is a heredoc that takes its file, /etc/nsswitch.conf in production', () => {
      expect(NSSWITCH, 'an NSSWITCH heredoc').toBeDefined();
      expect(SCRIPT_TEXT).toMatch(/nss_problem\('\/etc\/nsswitch\.conf'\)/);
    });

    it.each([
      ['files systemd', 'passwd: files systemd\ngroup: files systemd\nshadow: files\n', ''],
      ['files alone, with comments', '# local only\npasswd:files\ngroup:   files # here\n', ''],
      ['an action block before ldap', 'passwd: files [NOTFOUND=return]ldap\ngroup: files\n', /ldap/],
      ['an action block before sss', 'passwd: [!UNAVAIL=return]sss\ngroup: files\n', /sss/],
      ['an action block with spaces, then files', 'passwd: files [ NOTFOUND=return ] systemd\ngroup: files\n', ''],
      ['a bracket left unclosed', 'passwd: files [NOTFOUND=return\ngroup: files\n', /action block/],
      ['passwd listed twice', 'passwd: files\npasswd: files ldap\ngroup: files\n', /more than once/],
      ['no group line', 'passwd: files\n', /no group line/],
      ['compat', 'passwd: compat\ngroup: compat\n', /compat/],
      ['nis', 'passwd: files nis\ngroup: files\n', /nis/],
    ])('judges %s', (_label, text, expected) => {
      const found = gate(text);
      if (expected === '') expect(found).toBe('');
      else expect(found).toMatch(expected);
    });
  });

  describe('the read-only mount check', () => {
    const MOUNTINFO = heredoc('MOUNTINFO');
    const FIXTURE = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro',
      '30 22 8:2 / /srv/My\\040Photos ro,relatime shared:5 master:1 - ext4 /dev/sdb1 rw',
      '31 22 8:3 / /srv/data rw,relatime - ext4 /dev/sdc1 ro,errors=remount-ro',
      '32 22 8:4 / /srv/fine rw,nosuid shared:9 - xfs /dev/sdd1 rw,attr2',
      '33 32 8:5 / /srv/fine/inner\\040ro rw - tmpfs tmpfs rw',
      // A read-only deeper mount, then a writable one mounted later over its parent, which hides it.
      '40 22 8:6 / /srv/over/deep ro - ext4 /dev/sde1 ro',
      '41 22 8:7 / /srv/over rw - ext4 /dev/sdf1 rw',
      // The same point mounted twice: the later one is what the path sees.
      '42 22 8:8 / /srv/twice rw - ext4 /dev/sdg1 rw',
      '43 22 8:9 / /srv/twice ro - ext4 /dev/sdh1 rw',
    ].join('\n');
    const check = (library) => {
      const root = tempRoot();
      const file = path.join(root, 'mountinfo');
      fs.writeFileSync(file, `${FIXTURE}\n`);
      return spawnSync(realBin('perl'), ['-e', MOUNTINFO, '--', file, library], { encoding: 'utf8' }).stdout;
    };

    it('has a parser that takes its file, /proc/self/mountinfo in production', () => {
      expect(MOUNTINFO, 'a MOUNTINFO heredoc').toBeDefined();
      expect(SCRIPT_TEXT).toMatch(/perl -e "\$MOUNTINFO" -- \/proc\/self\/mountinfo/);
    });

    it.each([
      ['a read-only mount, by its own options, with an escaped space and optional fields', '/srv/My Photos/library', '/srv/My Photos'],
      ['a mount whose filesystem went read-only, by the super options after the separator', '/srv/data/photos', '/srv/data'],
      ['a writable mount', '/srv/fine/photos', ''],
      ['the deepest mount, writable, under a name that ends in ro', '/srv/fine/inner ro/photos', ''],
      ['the root mount, whose errors=remount-ro option is not ro', '/home/me/photos', ''],
      ['a writable mount made later over the parent of a read-only one', '/srv/over/deep/photos', ''],
      ['the later of two mounts on one point, read-only', '/srv/twice/photos', '/srv/twice'],
    ])('finds %s', (_label, library, expected) => {
      expect(check(library)).toBe(expected);
    });
  });

  describe("move-back.sh's helper, going back", () => {
    /** A library and an aside folder after an --apply: thumbnails moved, ids recorded. */
    async function moved() {
      const root = tempRoot();
      const library = fullLibrary(root);
      const { status, stderr } = run(['--manifest', await manifestFor(library), '--apply', library]);
      expect(status, stderr).toBe(0);
      const aside = asideOf(library);
      return { root, library, aside, args: ['back', aside, idOf(aside), library, idOf(library), 'thumbnails', idOf(path.join(aside, 'thumbnails'))] };
    }
    const afterBack = (perl) => String.raw`BEGIN { *CORE::GLOBAL::rename = sub ($$) { my ($from, $to) = @_; my $ok = CORE::rename($from, $to); if ($ok && !$main::done++) { ${perl} } return $ok } }`;
    const back = (args, perl) => spawnSync(realBin('perl'), ['-e', `${afterBack(perl)}\n${BACK}`, '--', ...args], { encoding: 'utf8' });

    it('moves what arrived straight back to the aside folder when it is not the moved folder', async () => {
      const { library, aside, args } = await moved();
      const result = back(args, String.raw`CORE::rename('${library}/thumbnails', '${library}.parked'); mkdir '${library}/thumbnails';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/went straight back/);
      expect(fs.existsSync(path.join(library, 'thumbnails'))).toBe(false);
      expect(fs.readdirSync(path.join(aside, 'thumbnails'))).toEqual([]);
    });

    it('leaves it where it is when the aside folder changed', async () => {
      const { library, aside, args } = await moved();
      const result = back(args, String.raw`CORE::rename('${library}/thumbnails', '${library}.parked'); mkdir '${library}/thumbnails'; CORE::rename('${aside}', '${aside}-old'); mkdir '${aside}';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/aside folder .* changed[\s\S]*left where it is/);
      expect(fs.readdirSync(path.join(library, 'thumbnails'))).toEqual([]);
      expect(fs.readdirSync(aside)).toEqual([]);
    });

    it('leaves it where it is when the aside folder holds the name again, in any case', async () => {
      const { library, aside, args } = await moved();
      const result = back(args, String.raw`CORE::rename('${library}/thumbnails', '${library}.parked'); mkdir '${library}/thumbnails'; mkdir '${aside}/Thumbnails';`);
      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toMatch(/holds thumbnails again[\s\S]*left where it is/);
      expect(fs.readdirSync(path.join(library, 'thumbnails'))).toEqual([]);
    });
  });

  it('handles a library path with spaces, quotes, $, a leading - and glob characters', async () => {
    const root = tempRoot();
    const library = fullLibrary(path.join(root, "-my 'odd' $HOME [a]*"));
    const manifest = await manifestFor(library);
    const before = tree(library);
    const dry = run(['--manifest', manifest, '--', library]);
    expect(dry.status, dry.stderr).toBe(0);
    const { status, stderr } = run(['--manifest', manifest, '--apply', '--', library]);
    expect(status, stderr).toBe(0);
    const dest = asideOf(library);
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
    const result = moveBack(library);
    expect(result.status, result.stderr).toBe(0);
    expect(tree(library)).toEqual(before);
  });

  it('takes a relative library, and one with a trailing slash', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const dry = run(['--manifest', manifest, 'photos/'], {}, root);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`Library: ${library}\n`);
    const { status, stderr } = run(['--manifest', manifest, './photos', '--apply'], {}, root);
    expect(status, stderr).toBe(0);
    expect(fs.readdirSync(asideOf(library))).toContain('lqip');
  });

  it('refuses when it can not read into a folder the manifest vouches for', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const locked = path.join(library, 'cache', 'dynamic');
    const before = tree(root);
    fs.chmodSync(locked, 0o000);
    let result;
    try {
      // It can't check what it can't list, so it never guesses.
      result = run(['--manifest', manifest, library]);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(/Can't read cache\/dynamic.*Nothing was moved/s);
    expect(tree(root)).toEqual(before);
  });
});
