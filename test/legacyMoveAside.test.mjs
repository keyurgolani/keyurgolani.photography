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

/** The real path of a command, before any stub goes on PATH. */
function realBin(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  if (!found.startsWith('/')) throw new Error(`no ${name} on PATH`);
  return found;
}
const BASH = realBin('bash');

function run(args, env = {}, cwd = undefined) {
  const result = spawnSync(BASH, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A sh `case` that matches exactly `file`, which holds no single quote. */
const caseOf = (file) => `'${file}'`;

/** Stubs in a bin folder ahead of PATH: `stat` and `df` answer for the paths given, and pass the rest to the real ones. */
function stubs(root, { devices = {}, mounts = [], perlFailsOn = 0 } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = (name, body) => {
    write(path.join(bin, name), `#!/bin/sh\n${body}`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  const statCases = Object.entries(devices).map(([file, device]) => `  ${caseOf(file)}) dev=${device} ;;\n`).join('');
  stub('stat', `for last; do :; done\ncase "$last" in\n${statCases}  *) exec ${realBin('stat')} "$@" ;;\nesac\ncase "$*" in *%i*) echo "$dev:1" ;; *) echo "$dev" ;; esac\n`);
  const dfCases = mounts.map((file) => `  ${caseOf(file)}) echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "stubfs 1 1 1 1% $last"; exit 0 ;;\n`).join('');
  stub('df', `for last; do :; done\ncase "$last" in\n${dfCases}esac\nexec ${realBin('df')} "$@"\n`);
  const count = path.join(bin, 'perl-calls');
  stub('perl', `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${count}'\nif [ "$n" -eq ${perlFailsOn} ]; then echo 'stubbed rename failure' >&2; exit 1; fi\nexec ${realBin('perl')} "$@"\n`);
  return { PATH: `${bin}:${process.env.PATH}` };
}

/** Runs `lines` with bash, as the owner would paste them. */
const runLines = (lines) => spawnSync(BASH, ['-c', lines.join('\n')], { encoding: 'utf8' });

/** Every file under `dir` but the saved way back. */
const withoutMoveBack = (files) => Object.fromEntries(Object.entries(files).filter(([relative]) => relative !== 'move-back.sh'));

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

  it('exits 2 on a missing library or an unknown flag, and moves nothing', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const before = tree(root);
    expect(run([]).status).toBe(2);
    expect(run([library, '--force']).status).toBe(2);
    expect(run([library, '--to']).status).toBe(2);
    expect(run([library, '--to', path.join(root, 'a'), '--to', path.join(root, 'b')]).status).toBe(2);
    expect(run([library, library]).status).toBe(2);
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
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, 'move-back.sh'].sort());
    const moved = {};
    for (const [relative, digest] of Object.entries(before)) {
      if (NAMES.includes(relative.split(path.sep)[0])) moved[relative] = digest;
    }
    expect(withoutMoveBack(tree(dest))).toEqual(moved);
    expect(tree(library)).toEqual(Object.fromEntries(Object.entries(before).filter(([relative]) => !(relative in moved))));
    for (const name of NAMES) expect(stdout).toMatch(new RegExp(`^mv ${literal(`'${library}/${name}' '${dest}/${name}'`)}`, 'm'));

    // The printed way back, run as printed.
    const back = stdout.split('\n').filter((line) => line.includes(`mv '${dest}/`));
    expect(back).toHaveLength(8);
    const result = runLines(back);
    expect(result.status).toBe(0);
    expect(tree(library)).toEqual(before);
    expect(fs.readdirSync(dest)).toEqual(['move-back.sh']);
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
    const result = runLines(back);
    expect(result.stderr).toMatch(/lqip/);
    expect(fs.readdirSync(path.join(library, 'lqip'))).toEqual(['restored.txt']);
    expect(fs.readdirSync(dest).sort()).toEqual(['lqip', 'move-back.sh']);
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
    expect(fs.readdirSync(dest).sort()).toEqual(['lqip', 'move-back.sh']);
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

    it('for a destination holding any of the eight, even one the library has no folder for', () => {
      const root = tempRoot();
      const library = path.join(root, 'photos');
      write(path.join(library, 'thumbnails', 'a.webp'), crypto.randomBytes(64));
      const dest = path.join(root, 'aside');
      write(path.join(dest, 'medium', 'old.webp'), 'x');
      expectRefused(root, [library, '--to', dest, '--apply'], /already holds medium/);
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
      const other = path.join(root, 'other-disk');
      fs.mkdirSync(other);
      const env = stubs(root, { devices: { [other]: 999999 } });
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, env);
      expectRefused(root, [library, '--to', path.join(other, 'aside')], /another filesystem/, env);
      // The same stubs leave a destination on the library's device alone.
      expect(run([library, '--to', path.join(root, 'aside')], env).status).toBe(0);
    });

    it('for a destination on another mount of the same device, through a stubbed df', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const other = path.join(root, 'bind-mount');
      fs.mkdirSync(other);
      const env = stubs(root, { mounts: [other] });
      expectRefused(root, [library, '--to', path.join(other, 'aside'), '--apply'], /another filesystem/, env);
    });

    it('for a legacy folder that is a mount point of its own', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const env = stubs(root, { devices: { [path.join(library, 'cache')]: 999999 } });
      expectRefused(root, [library, '--apply'], /cache is on another filesystem/, env);
    });

    it('for a destination that differs from the library only in case, on a case-insensitive disk', (ctx) => {
      const root = tempRoot();
      const library = fullLibrary(root);
      if (!fs.existsSync(path.join(root, 'PHOTOS'))) ctx.skip();
      expectRefused(root, [library, '--to', path.join(root, 'PHOTOS', 'aside'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'PHOTOS'), '--apply'], /inside/);
      expectRefused(root, [library, '--to', path.join(root, 'Photos', 'Trip'), '--apply'], /inside/);
    });

    it('for a destination reached through a symlinked parent', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      fs.symlinkSync(root, path.join(root, 'up'));
      expectRefused(root, [library, '--to', path.join(root, 'up', 'photos', 'aside'), '--apply'], /inside/);
    });

    it("for a destination under a checkout's public/ folder, the default included", () => {
      const root = tempRoot();
      write(path.join(root, 'package.json'), '{}');
      const library = fullLibrary(path.join(root, 'public', 'assets'));
      expectRefused(root, [library, '--apply'], /public.*--to/s);
      expectRefused(root, [library, '--to', path.join(root, 'public', 'elsewhere'), '--apply'], /public/);
      expect(run([library, '--to', path.join(root, 'aside')]).status).toBe(0);
    });

    it("for a public/ folder beside next.config.*, and not for a host's public/ with neither", () => {
      const root = tempRoot();
      write(path.join(root, 'next.config.mjs'), 'export default {};\n');
      const library = fullLibrary(path.join(root, 'public', 'assets'));
      expectRefused(root, [library], /public/);
      const host = tempRoot();
      write(path.join(host, 'docker-compose.prod.yml'), 'services: {}\n');
      const hostLibrary = fullLibrary(path.join(host, 'public', 'assets'));
      expect(run([hostLibrary]).status).toBe(0);
    });

    it('for a host without perl, which the rename-only move needs', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      // A PATH with every tool the script uses but perl.
      const bin = path.join(root, 'no-perl');
      fs.mkdirSync(bin);
      for (const tool of ['stat', 'df', 'du', 'awk', 'date', 'dirname', 'basename', 'mkdir', 'find', 'chmod', 'cat', 'wc', 'head', 'id']) fs.symlinkSync(realBin(tool), path.join(bin, tool));
      expectRefused(root, [library, '--apply'], /perl/, { PATH: bin });
    });
  });

  describe('with --apply', () => {
    it('writes the way back to move-back.sh in the aside folder before the first move, and it works', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const before = tree(library);
      const { status, stdout } = run([library, '--apply']);
      expect(status).toBe(0);
      const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
      const file = path.join(dest, 'move-back.sh');
      expect(fs.statSync(file).mode & 0o777).toBe(0o644);
      expect(stdout).toContain(file);
      const result = spawnSync(BASH, [file], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(tree(library)).toEqual(before);
    });

    it('stops at a failed rename, says what moved, and leaves a move-back.sh that undoes just that', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const before = tree(library);
      const env = stubs(root, { perlFailsOn: 3 });
      const { status, stderr } = run([library, '--apply'], env);
      expect(status).toBe(1);
      expect(stderr).toMatch(/Stopped/);
      expect(stderr).toMatch(/thumbnails medium/);
      const dest = path.join(root, `photos.legacy-derivatives-${today()}`);
      expect(fs.readdirSync(dest).sort()).toEqual(['medium', 'move-back.sh', 'thumbnails']);
      const result = spawnSync(BASH, [path.join(dest, 'move-back.sh')], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(tree(library)).toEqual(before);
    });

    it('says the aside folder is safe to leave when the first rename fails', () => {
      const root = tempRoot();
      const library = fullLibrary(root);
      const before = tree(library);
      const { status, stderr } = run([library, '--apply'], stubs(root, { perlFailsOn: 1 }));
      expect(status).toBe(1);
      expect(stderr).toMatch(/Nothing was moved/);
      expect(stderr).toMatch(/safe to leave/);
      expect(tree(library)).toEqual(before);
    });
  });

  it('handles a library path with spaces, quotes, $, a leading - and glob characters', () => {
    const root = tempRoot();
    const library = fullLibrary(path.join(root, "-my 'odd' $HOME [a]*"));
    const before = tree(library);
    const dry = run(['--', library]);
    expect(dry.status, dry.stderr).toBe(0);
    const { status, stdout, stderr } = run(['--apply', '--', library]);
    expect(status, stderr).toBe(0);
    const dest = `${library}.legacy-derivatives-${today()}`;
    expect(fs.readdirSync(dest).sort()).toEqual([...NAMES, 'move-back.sh'].sort());
    const back = stdout.split('\n').filter((line) => line.startsWith('if '));
    expect(back).toHaveLength(8);
    expect(runLines(back).status).toBe(0);
    expect(tree(library)).toEqual(before);
  });

  it('takes a relative library, and one with a trailing slash', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    const dry = run(['photos/'], {}, root);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`Library: ${library}\n`);
    const { status } = run(['./photos', '--apply'], {}, root);
    expect(status).toBe(0);
    expect(fs.readdirSync(path.join(root, `photos.legacy-derivatives-${today()}`))).toContain('lqip');
  });

  it('gives an unknown size for a folder it cannot read into, and still ends with the summary', () => {
    if (process.getuid?.() === 0) return;
    const root = tempRoot();
    const library = fullLibrary(root);
    const locked = path.join(library, 'cache', 'dynamic');
    const before = tree(root);
    fs.chmodSync(locked, 0o000);
    try {
      const { status, stdout } = run([library]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/cache'.*size unknown, run with sudo/);
      expect(stdout).toMatch(/^Total: 8 folders, [0-9.]+ [kMG]B on disk, not counting 1 whose size is unknown/m);
      expect(stdout).toMatch(/Dry run: nothing was moved/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(tree(root)).toEqual(before);
  });

  it('warns about files without their folder\'s extension, and still moves them', () => {
    const root = tempRoot();
    const library = fullLibrary(root);
    write(path.join(library, 'thumbnails', 'holiday.jpg'), crypto.randomBytes(64));
    write(path.join(library, 'lqip', 'x.webp'), crypto.randomBytes(64));
    const dry = run([library]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/2 files.*may not be derivatives/);
    expect(dry.stdout).toContain(path.join(library, 'thumbnails', 'holiday.jpg'));
    expect(dry.stdout).toContain(path.join(library, 'lqip', 'x.webp'));
    const { status } = run([library, '--apply']);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(root, `photos.legacy-derivatives-${today()}`, 'thumbnails', 'holiday.jpg'))).toBe(true);
  });
});
