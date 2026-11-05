// @vitest-environment node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../lib/derivativeFolders.mjs';
import { buildLegacyManifest, legacyManifestUsedFile, sealLegacyManifest, writeLegacyManifest } from '../lib/identity/legacy-derivatives';

// scripts/host/legacy-move-aside.sh (#15, v2.0.0 A12) moves the legacy
// derivative folders a watcher before v1.7.0 wrote out of the photo library,
// to a folder beside it on the same filesystem. It runs on the host, against
// the owner's originals, and a folder's name is never enough to move it: on a
// case-insensitive disk `medium` is also the owner's `Medium` album. So it
// moves only folders the manifest `photos legacy-derivatives` writes vouches
// for, and only while each still lists exactly what the manifest holds. These
// tests run only on temp folders: a temp library, and a temp data root beside
// it for the manifest.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'host', 'legacy-move-aside.sh');
const NAMES = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A temp folder for one test's library and data root, resolved so paths compare with the script's. */
function tempRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-move-aside-')));
  roots.push(root);
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
 * all eight legacy folders, each holding only derivatives of the root
 * originals, `cache/dynamic/` as the old image route named its files.
 */
function fullLibrary(parent) {
  const library = path.join(parent, 'photos');
  write(path.join(library, 'a.jpg'), crypto.randomBytes(2048));
  write(path.join(library, 'b.png'), crypto.randomBytes(1024));
  write(path.join(library, 'trip', 'c.jpg'), crypto.randomBytes(1024));
  for (const [folder, extension] of Object.entries(DERIVATIVE_FOLDERS)) {
    write(path.join(library, folder, `a${extension}`), crypto.randomBytes(512));
    write(path.join(library, folder, `b${extension}`), crypto.randomBytes(300));
  }
  write(path.join(library, CACHE_FOLDER, 'dynamic', 'a-400-75.webp'), crypto.randomBytes(700));
  write(path.join(library, CACHE_FOLDER, 'dynamic', 'b-1920-60.avif'), crypto.randomBytes(500));
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

/** Runs the script. An env value of undefined unsets that variable. */
function run(args, env = {}, cwd = undefined) {
  const merged = { ...process.env, ...env };
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

/** A sh `case` pattern that matches exactly `file`, which holds no single quote. */
const caseOf = (file) => `'${file}'`;

/**
 * Stubs in a bin folder ahead of PATH. `stat` answers for the paths in
 * `devices` (a device ID), `ids` (a full `dev:inode`) and `statFails`, and
 * passes the rest to the real one; `df` gives the paths in `mounts` a mount
 * of their own; `perl` fails its `perlFailsOn`th rename.
 */
function stubs(root, { devices = {}, ids = {}, statFails = [], mounts = [], perlFailsOn = 0 } = {}) {
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
  stub('perl', `case "$2" in *rename*)\n  n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${count}'\n  if [ "$n" -eq ${perlFailsOn} ]; then echo 'stubbed rename failure' >&2; exit 1; fi ;;\nesac\nexec ${realBin('perl')} "$@"\n`);
  return { PATH: `${bin}:${process.env.PATH}` };
}

/** A PATH holding links to the given tools only. */
function onlyTools(root, name, tools) {
  const bin = path.join(root, name);
  fs.mkdirSync(bin);
  for (const tool of tools) fs.symlinkSync(realBin(tool), path.join(bin, tool));
  return { PATH: bin };
}
const SCRIPT_TOOLS = ['stat', 'df', 'du', 'awk', 'date', 'dirname', 'basename', 'mkdir', 'cat', 'perl'];

/** Runs `lines` with bash, as the owner would paste them. */
const runLines = (lines) => spawnSync(BASH, ['-c', lines.join('\n')], { encoding: 'utf8' });

/** `text` as a literal inside a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const asideOf = (library) => `${library}.legacy-derivatives-${today()}`;
const AFTER_APPLY = ['legacy-derivatives.used', 'move-back.sh'];

// Each test runs the real script, often several times, so a loaded machine gets 30 s a test.
describe('scripts/host/legacy-move-aside.sh', { timeout: 30_000 }, () => {
  it('names exactly the eight folders lib/derivativeFolders.mjs lists, in its order', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    const list = text.match(/^NAMES=\(([^)]*)\)/m);
    expect(list, 'a NAMES=(...) line').not.toBeNull();
    expect(list[1].trim().split(/\s+/)).toEqual(NAMES);
  });

  it("keeps the default aside folder out of the image's build context and out of git", () => {
    const lines = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').map((line) => line.trim());
    expect(lines('.dockerignore')).toContain('public/assets/photos.legacy-derivatives-*');
    expect(lines('.gitignore')).toContain('public/assets/photos.legacy-derivatives-*/');
  });

  it('has no delete in it: no rm, unlink, rmdir, shred or find -delete', () => {
    const code = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
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

  it('is a dry run by default: what moves and what stays, each mv with its size, the total and the way back, and it writes nothing', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    write(path.join(library, 'medium', 'holiday.jpg'), crypto.randomBytes(64));
    const manifest = await manifestFor(library);
    const before = tree(root);
    const { status, stdout, stderr } = run(['--manifest', manifest, library]);
    expect(status, stderr).toBe(0);
    expect(tree(root)).toEqual(before);
    const dest = asideOf(library);
    expect(fs.existsSync(dest)).toBe(false);
    const moving = NAMES.filter((name) => name !== 'medium');
    for (const name of moving) {
      expect(stdout).toMatch(new RegExp(`^mv ${literal(`'${library}/${name}' '${dest}/${name}'`)} +# [0-9.]+ [kMG]B$`, 'm'));
      expect(stdout).toContain(`mv '${dest}/${name}' '${library}/${name}'`);
    }
    // At a glance: each moving folder with its count and first names, each staying one with why.
    expect(stdout).toMatch(/^Moves aside, 7 folders:$/m);
    expect(stdout).toMatch(/^ {2}thumbnails: 2 files, such as a\.webp, b\.webp$/m);
    expect(stdout).toMatch(/^ {2}cache: 2 files, such as dynamic\/a-400-75\.webp, dynamic\/b-1920-60\.avif$/m);
    expect(stdout).toMatch(/^Stays, 1 folder:$/m);
    expect(stdout).toMatch(/^ {2}medium: medium\/holiday\.jpg has an original's extension$/m);
    expect(stdout).not.toMatch(/^mv '[^']*\/medium'/m);
    expect(stdout).toMatch(/^Total: 7 folders, [0-9.]+ [kMG]B/m);
    expect(stdout).toMatch(/Dry run: nothing was moved/);
  });

  it('--apply moves exactly the eight names, every file byte-identical, and its way back puts them back', async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
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

    // The printed way back, run as printed.
    const back = stdout.split('\n').filter((line) => line.includes(`mv '${dest}/`));
    expect(back).toHaveLength(8);
    const result = runLines(back);
    expect(result.status).toBe(0);
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
    const result = spawnSync(BASH, [file], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(library)).toEqual(before);
  });

  it("prints a way back that won't move a folder into one the library holds again", async () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const { status, stdout } = run(['--manifest', await manifestFor(library), '--apply', library]);
    expect(status).toBe(0);
    const dest = asideOf(library);
    // As after restoring a backup made before the move.
    write(path.join(library, 'lqip', 'restored.txt'), 'x');
    const back = stdout.split('\n').filter((line) => line.includes(`mv '${dest}/`));
    const result = runLines(back);
    expect(result.stderr).toMatch(/lqip/);
    expect(fs.readdirSync(path.join(library, 'lqip'))).toEqual(['restored.txt']);
    expect(fs.readdirSync(dest).sort()).toEqual(['lqip', ...AFTER_APPLY].sort());
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'b.png', ...NAMES, 'trip'].sort());
  });

  it('leaves a nested thumbnails/, a file named medium, a symlink and an unknown folder where they are', async () => {
    const root = tempRoot();
    const library = path.join(root, 'photos');
    write(path.join(library, 'a.jpg'), crypto.randomBytes(256));
    write(path.join(library, 'trip', 'thumbnails', 'a.webp'), crypto.randomBytes(256));
    write(path.join(library, 'medium'), crypto.randomBytes(64));
    write(path.join(root, 'elsewhere', 'a.webp'), crypto.randomBytes(64));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(library, 'optimized'));
    write(path.join(library, 'thumbnails.old', 'a.webp'), crypto.randomBytes(64));
    write(path.join(library, 'lqip', 'a.txt'), 'data:image/webp;base64,AAAA');
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
    expect(stdout).toMatch(/medium.*isn't a folder/);
    expect(stdout).toMatch(/optimized.*symlink/);
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
      write(path.join(library, 'thumbnails', 'a.webp'), crypto.randomBytes(256));
      write(path.join(library, 'lqip', 'a.txt'), 'data:image/webp;base64,AAAA');
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
        write(path.join(library, 'Medium', 'a.webp'), crypto.randomBytes(128));
      });
      expect(stdout).not.toMatch(/[Mm]edium'/);
    });

    it('an album named Cache, on a case-insensitive disk', async (ctx) => {
      if (!caseInsensitive(tempRoot())) ctx.skip();
      const stdout = await owner((library) => {
        write(path.join(library, 'Cache', 'dynamic', 'a-400-75.webp'), crypto.randomBytes(128));
        write(path.join(library, 'Cache', 'street.jpg'), crypto.randomBytes(512));
      });
      expect(stdout).not.toMatch(/[Cc]ache'/);
    });

    it('an album named medium exactly, holding originals', async () => {
      const stdout = await owner((library) => {
        write(path.join(library, 'medium', 'portrait.jpg'), crypto.randomBytes(512));
        write(path.join(library, 'medium', 'a.webp'), crypto.randomBytes(128));
      });
      expect(stdout).not.toMatch(/^mv '[^']*\/medium'/m);
      expect(stdout).toMatch(/medium: .*has an original's extension/);
    });

    it('an album holding files that look like a marker or a manifest', async () => {
      const stdout = await owner((library) => {
        write(path.join(library, 'optimized', 'a.webp'), crypto.randomBytes(128));
        write(path.join(library, 'optimized', 'legacy-derivatives.json'), '{"schemaVersion":1,"folders":[]}');
        write(path.join(library, 'optimized', '.kgp-legacy'), 'legacy');
        write(path.join(library, 'trip', 'legacy-derivatives.json'), '{}');
        write(path.join(library, 'trip', '.kgp-legacy'), 'legacy');
        write(path.join(library, 'trip', 'b.jpg'), crypto.randomBytes(512));
      });
      expect(stdout).not.toMatch(/^mv '[^']*\/optimized'/m);
      expect(stdout).toMatch(/optimized: /);
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

    it('when it names another library', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = fullLibrary(path.join(root, 'other'));
      expectRefused(root, ['--manifest', await manifestFor(other), '--apply', library], /another library/);
    });

    it('when a folder it vouches for changed since', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      write(path.join(library, 'thumbnails', 'new.webp'), crypto.randomBytes(64));
      expectRefused(root, ['--manifest', manifest, '--apply', library], /thumbnails changed.*new\.webp/s);
      const other = tempRoot();
      const second = fullLibrary(other);
      const secondManifest = await manifestFor(second);
      fs.utimesSync(path.join(second, 'lqip', 'a.txt'), 1_600_000_000, 1_600_000_000);
      expectRefused(other, ['--manifest', secondManifest, '--apply', second], /lqip changed/);
    });

    it('when it was used for an earlier --apply, until it is written again', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const first = run(['--manifest', manifest, '--to', path.join(root, 'aside-1'), '--apply', library]);
      expect(first.status, first.stderr).toBe(0);
      const dataRoot = path.dirname(path.dirname(manifest));
      const digest = JSON.parse(fs.readFileSync(manifest, 'utf8')).digest;
      expect(fs.readFileSync(legacyManifestUsedFile(dataRoot), 'utf8').split('\n')).toContain(digest);
      expect(fs.readFileSync(path.join(root, 'aside-1', 'legacy-derivatives.used'), 'utf8').trim()).toBe(digest);
      expect(spawnSync(BASH, [path.join(root, 'aside-1', 'move-back.sh')], { encoding: 'utf8' }).status).toBe(0);
      expectRefused(root, ['--manifest', manifest, '--to', path.join(root, 'aside-2'), '--apply', library], /used for an earlier --apply.*again/s);
      const fresh = await manifestFor(library, { clock: () => Date.now() + 1000 });
      const again = run(['--manifest', fresh, '--to', path.join(root, 'aside-2'), '--apply', library]);
      expect(again.status, again.stderr).toBe(0);
      expect(fs.readdirSync(path.join(root, 'aside-2'))).toContain('thumbnails');
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
      const stat = fs.statSync(library);
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      const env = stubs(root, { ids: { [other]: `${stat.dev}:${stat.ino}` } });
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /is the library or inside it/, env);
    });

    it('with an ancestor stat can not read', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const deep = path.join(root, 'x', 'y');
      fs.mkdirSync(deep, { recursive: true });
      const env = stubs(root, { statFails: [path.join(root, 'x')] });
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
      write(path.join(library, 'thumbnails', 'a.webp'), crypto.randomBytes(64));
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
      const env = stubs(root, { devices: { [other]: 999999 } });
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, env);
      expectRefused(root, [library, '--to', path.join(other, 'aside')], /another filesystem/, env);
    });

    it('on another mount of the same device, through a stubbed df', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = path.join(root, 'bind-mount');
      fs.mkdirSync(other);
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, stubs(root, { mounts: [other] }));
    });

    it('for a legacy folder that is a mount point of its own', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      expectRefused(root, ['--manifest', manifest, '--apply', library], /cache is on another filesystem/, stubs(root, { devices: { [path.join(library, 'cache')]: 999999 } }));
    });

    it('when a path holds a newline', async () => {
      const root = tempRoot();
      const library = fullLibrary(path.join(root, 'line\nbreak'));
      expectRefused(root, ['--apply', library], /newline/);
      const plain = fullLibrary(path.join(root, 'plain'));
      expectRefused(root, ['--manifest', await manifestFor(plain), '--to', path.join(root, 'aside\nhere'), '--apply', plain], /newline/);
    });

    it('on a host without perl, which the manifest check and the rename-only move need', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      expectRefused(root, ['--apply', library], /perl/, onlyTools(root, 'no-perl', SCRIPT_TOOLS.filter((tool) => tool !== 'perl')));
    });
  });

  describe('with --apply', () => {
    it('stops at a failed rename, says what moved, and leaves a move-back.sh that undoes just that', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const before = snapshot(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], stubs(root, { perlFailsOn: 3 }));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Stopped/);
      expect(stderr).toMatch(/thumbnails medium/);
      expect(stderr).toMatch(/Run photos legacy-derivatives again/);
      const dest = asideOf(library);
      expect(fs.readdirSync(dest).sort()).toEqual(['medium', ...AFTER_APPLY, 'thumbnails'].sort());
      const result = spawnSync(BASH, [path.join(dest, 'move-back.sh')], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(snapshot(library)).toEqual(before);
    });

    it('says the aside folder is safe to leave when the first rename fails', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const before = tree(library);
      const { status, stderr } = run(['--manifest', manifest, '--apply', library], stubs(root, { perlFailsOn: 1 }));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(stderr).toMatch(/safe to leave/);
      expect(stderr).not.toMatch(/\b(?:rm|delete|remove)\b/i);
      expect(tree(library)).toEqual(before);
    });

    it('writes sudo mv into the way back only when run through sudo, with sudo on PATH', async () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const manifest = await manifestFor(library);
      const back = (env) => run(['--manifest', manifest, library], env).stdout.split('\n').filter((line) => line.startsWith('if '));
      const withSudo = stubs(root);
      write(path.join(root, 'bin', 'sudo'), '#!/bin/sh\nexec "$@"\n');
      fs.chmodSync(path.join(root, 'bin', 'sudo'), 0o755);
      expect(back({ ...withSudo, SUDO_USER: 'owner' }).every((line) => line.includes('; else sudo mv '))).toBe(true);
      expect(back({ ...withSudo, SUDO_USER: undefined }).some((line) => line.includes('sudo'))).toBe(false);
      const noSudo = onlyTools(root, 'tools-without-sudo', SCRIPT_TOOLS);
      const lines = back({ ...noSudo, SUDO_USER: 'owner' });
      expect(lines).toHaveLength(8);
      expect(lines.some((line) => line.includes('sudo'))).toBe(false);
    });
  });

  it('handles a library path with spaces, quotes, $, a leading - and glob characters', async () => {
    const root = tempRoot();
    const library = fullLibrary(path.join(root, "-my 'odd' $HOME [a]*"));
    const manifest = await manifestFor(library);
    const before = tree(library);
    const dry = run(['--manifest', manifest, '--', library]);
    expect(dry.status, dry.stderr).toBe(0);
    const { status, stdout, stderr } = run(['--manifest', manifest, '--apply', '--', library]);
    expect(status, stderr).toBe(0);
    const dest = asideOf(library);
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, ...AFTER_APPLY].sort());
    const back = stdout.split('\n').filter((line) => line.startsWith('if '));
    expect(back).toHaveLength(8);
    expect(runLines(back).status).toBe(0);
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

  it('refuses, and says to use sudo, when it can not read into a folder the manifest vouches for', async () => {
    if (process.getuid?.() === 0) return;
    const root = tempRoot();
    const library = fullLibrary(root);
    const manifest = await manifestFor(library);
    const locked = path.join(library, 'cache', 'dynamic');
    const before = tree(root);
    fs.chmodSync(locked, 0o000);
    try {
      // It can't check what it can't list, so it never guesses a size for it.
      const { status, stdout, stderr } = run(['--manifest', manifest, library]);
      expect(status, stdout).toBe(1);
      expect(stderr).toMatch(/Can't read cache\/dynamic.*sudo.*Nothing was moved/s);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(tree(root)).toEqual(before);
  });
});
