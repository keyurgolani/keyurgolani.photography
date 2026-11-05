// @vitest-environment node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../lib/derivativeFolders.mjs';

// scripts/host/legacy-move-aside.sh (#15, v2.0.0 A12) moves the legacy
// derivative folders a watcher before v1.7.0 wrote out of the photo library,
// to a folder beside it on the same filesystem. It runs on the host, against
// the owner's originals, so these tests hold it to its limits on a temp
// library: a dry run by default, the eight exact names only, real folders
// directly under the root only, never a delete, and a refusal with nothing
// moved for a destination inside the library, one that already holds a name,
// or one on another device.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'host', 'legacy-move-aside.sh');
const NAMES = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A temp folder holding `photos/`, the library, resolved so paths compare with the script's. */
function tempRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-move-aside-')));
  roots.push(root);
  return root;
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

/** A library with originals, all eight legacy folders full of files, and a nested `cache/dynamic/`. */
function fullLibrary(root) {
  const library = path.join(root, 'photos');
  write(path.join(library, 'a.jpg'), crypto.randomBytes(2048));
  write(path.join(library, 'trip', 'b.jpg'), crypto.randomBytes(1024));
  for (const [folder, extension] of Object.entries(DERIVATIVE_FOLDERS)) {
    write(path.join(library, folder, `a${extension}`), crypto.randomBytes(512));
    write(path.join(library, folder, `b${extension}`), crypto.randomBytes(300));
  }
  write(path.join(library, CACHE_FOLDER, 'dynamic', 'x.bin'), crypto.randomBytes(700));
  return library;
}

/** Every file and folder under `dir`, as relative path to its bytes' digest, or `dir`/`link -> target`. Symlinks aren't followed. */
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

function run(args, env = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `text` as a literal inside a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

describe('scripts/host/legacy-move-aside.sh', () => {
  it('names exactly the eight folders lib/derivativeFolders.mjs lists, in its order', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    const list = text.match(/^NAMES=\(([^)]*)\)/m);
    expect(list, 'a NAMES=(...) line').not.toBeNull();
    expect(list[1].trim().split(/\s+/)).toEqual(NAMES);
  });

  it('has no delete in it: no rm, unlink, rmdir, shred or find -delete', () => {
    const code = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(code).not.toMatch(/(?:^|[\s;&|(`$])(?:sudo\s+)?(?:rm|unlink|rmdir|shred)(?:\s|$)|-delete\b/m);
  });

  it('exits 2 on a missing library or an unknown flag, and moves nothing', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const before = tree(root);
    expect(run([]).status).toBe(2);
    expect(run([library, '--force']).status).toBe(2);
    expect(run([library, '--to']).status).toBe(2);
    expect(tree(root)).toEqual(before);
  });

  it('is a dry run by default: it lists each move with its size, the total and the way back, and writes nothing', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const before = tree(root);
    const { status, stdout } = run([library]);
    expect(status).toBe(0);
    expect(tree(root)).toEqual(before);
    const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
    expect(fs.existsSync(dest)).toBe(false);
    for (const name of NAMES) {
      expect(stdout).toMatch(new RegExp(`^mv ${literal(`'${library}/${name}' '${dest}/${name}'`)} +# [0-9.]+ [kMG]B$`, 'm'));
      expect(stdout).toContain(`mv '${dest}/${name}' '${library}/${name}'`);
    }
    expect(stdout).toMatch(/^Total: 8 folders, [0-9.]+ [kMG]B/m);
    expect(stdout).toMatch(/Dry run: nothing was moved/);
  });

  it('--apply moves exactly the eight names, every file byte-identical, and its way back puts them back', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const before = tree(library);
    const { status, stdout, stderr } = run([library, '--apply']);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'trip']);
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES].sort());
    const moved = {};
    for (const [relative, digest] of Object.entries(before)) {
      if (NAMES.includes(relative.split(path.sep)[0])) moved[relative] = digest;
    }
    expect(tree(dest)).toEqual(moved);
    expect(tree(library)).toEqual(Object.fromEntries(Object.entries(before).filter(([relative]) => !(relative in moved))));
    for (const name of NAMES) expect(stdout).toMatch(new RegExp(`^mv ${literal(`'${library}/${name}' '${dest}/${name}'`)}`, 'm'));

    // The printed way back, run as printed.
    const back = stdout.split('\n').filter((line) => line.includes(`mv '${dest}/`));
    expect(back).toHaveLength(8);
    const result = spawnSync('bash', ['-c', back.join('\n')], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(tree(library)).toEqual(before);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("prints a way back that won't move a folder into one the library holds again", () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const { status, stdout } = run([library, '--apply']);
    expect(status).toBe(0);
    const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
    // As after restoring a backup made before the move.
    write(path.join(library, 'lqip', 'restored.txt'), 'x');
    const back = stdout.split('\n').filter((line) => line.includes(`mv '${dest}/`));
    const result = spawnSync('bash', ['-c', back.join('\n')], { encoding: 'utf8' });
    expect(result.stderr).toMatch(/lqip/);
    expect(fs.readdirSync(path.join(library, 'lqip'))).toEqual(['restored.txt']);
    expect(fs.readdirSync(dest)).toEqual(['lqip']);
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', ...NAMES, 'trip'].sort());
  });

  it('leaves a nested thumbnails/, a file named medium, a symlink and an unknown folder where they are', () => {
    const root = tempRoot();
    const library = path.join(root, 'photos');
    write(path.join(library, 'a.jpg'), crypto.randomBytes(256));
    write(path.join(library, 'trip', 'thumbnails', 'b.webp'), crypto.randomBytes(256));
    write(path.join(library, 'medium'), crypto.randomBytes(64));
    write(path.join(root, 'elsewhere', 'c.webp'), crypto.randomBytes(64));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(library, 'optimized'));
    write(path.join(library, 'thumbnails.old', 'd.webp'), crypto.randomBytes(64));
    write(path.join(library, 'lqip', 'a.txt'), 'data:image/webp;base64,AAAA');
    const before = tree(root);
    const { status, stdout } = run([library, '--apply']);
    expect(status).toBe(0);
    const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
    expect(fs.readdirSync(dest)).toEqual(['lqip']);
    expect(fs.readdirSync(library).sort()).toEqual(['a.jpg', 'medium', 'optimized', 'thumbnails.old', 'trip']);
    const after = tree(root);
    for (const kept of ['photos/trip/thumbnails/b.webp', 'photos/medium', 'photos/optimized', 'photos/thumbnails.old/d.webp', 'elsewhere/c.webp']) {
      expect(after[kept], kept).toBe(before[kept]);
    }
    expect(stdout).toMatch(/medium.*isn't a folder/);
    expect(stdout).toMatch(/optimized.*symlink/);
  });

  it('says so and moves nothing when the library holds none of the names', () => {
    const root = tempRoot();
    const library = path.join(root, 'photos');
    write(path.join(library, 'a.jpg'), crypto.randomBytes(256));
    const before = tree(root);
    const { status, stdout } = run([library, '--apply']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Nothing to move/);
    expect(tree(root)).toEqual(before);
  });

  describe('refuses, exits 1 and moves nothing', () => {
    function expectRefused(root, args, pattern, env) {
      const before = tree(root);
      const { status, stdout, stderr } = run(args, env);
      expect(status, stdout + stderr).toBe(1);
      expect(stderr).toMatch(pattern);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(tree(root)).toEqual(before);
    }

    it('for a destination inside the library, or the library itself', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      expectRefused(root, [library, '--to', path.join(library, 'aside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(library, 'trip'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', library, '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(library, 'trip', '..', 'aside'), '--apply'], /inside/);
    });

    it('for a destination that reaches into the library through a symlink', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(path.join(library, 'trip'), path.join(root, 'looks-outside'));
      expectRefused(root, [library, '--to', path.join(root, 'looks-outside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'looks-outside', 'aside'), '--apply'], /inside/);
    });

    it('for a library reached through a symlink, with the destination inside the real one', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(library, path.join(root, 'link'));
      expectRefused(root, [path.join(root, 'link'), '--to', path.join(library, 'aside'), '--apply'], /inside/);
    });

    it('for a destination that already holds any of the names', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const dest = path.join(root, 'aside');
      write(path.join(dest, 'lqip', 'old.txt'), 'x');
      expectRefused(root, [library, '--to', dest, '--apply'], /already holds/);
      fs.renameSync(path.join(dest, 'lqip'), path.join(root, 'lqip-elsewhere'));
      fs.symlinkSync(path.join(root, 'lqip-elsewhere'), path.join(dest, 'cache'));
      expectRefused(root, [library, '--to', dest, '--apply'], /already holds/);
    });

    it('for a destination that is a file, or whose parent is missing', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      write(path.join(root, 'a-file'), 'x');
      expectRefused(root, [library, '--to', path.join(root, 'a-file'), '--apply'], /isn't a folder/);
      expectRefused(root, [library, '--to', path.join(root, 'no', 'such', 'aside'), '--apply'], /isn't a folder/);
    });

    it('for a destination on another device, through a stubbed device check', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      // A `stat` ahead of the real one on PATH that gives the destination's parent another device ID.
      const bin = path.join(root, 'bin');
      const other = path.join(root, 'other-disk');
      fs.mkdirSync(other);
      write(path.join(bin, 'stat'), `#!/bin/sh\nfor last; do :; done\nif [ "$last" = '${other}' ]; then echo 999999; exit 0; fi\nexec /usr/bin/stat "$@"\n`);
      fs.chmodSync(path.join(bin, 'stat'), 0o755);
      const env = { PATH: `${bin}:${process.env.PATH}` };
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, env);
      expectRefused(root, [library, '--to', path.join(other, 'aside')], /another filesystem/, env);
      // The same stub leaves a destination on the library's device alone.
      const { status } = run([library, '--to', path.join(root, 'aside')], env);
      expect(status).toBe(0);
    });
  });
});
