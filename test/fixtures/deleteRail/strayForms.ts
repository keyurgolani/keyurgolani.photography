/**
 * The delete rail's second positive control (test/deleteRail.test.ts, #181's
 * A10 review item 16): each form the second review found the rail missed.
 * Nothing imports or runs it.
 */

import * as cp from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

declare const fse: { remove(dir: string): Promise<void>; removeSync(dir: string): void; emptyDir(dir: string): Promise<void>; emptyDirSync(dir: string): void };

export function viaArrayElement(dir: string): void {
    spawnSync('sh', ['-c', 'rm -rf build/']);
    execFileSync('xargs', ['rm', dir]);
}

export function viaComputedCommand(command: string, args: string[]): void {
    cp.spawn(command, args);
    cp.exec(`${command} --now`);
}

export function viaShellScript(script: string): void {
    spawnSync('bash', ['-c', `${script}`]);
}

export function viaGitAndFind(): void {
    execFileSync('git', ['clean', '-fdx']);
    cp.execSync('git clean -fd');
    spawnSync('find', ['.', '-name', '*.tmp', '-delete']);
}

export async function viaComputedAccess(name: 'rm' | 'unlink', file: string): Promise<void> {
    await fs.promises['unlink'](file);
    const method = fsp[name];
    await method(file);
    const reached = Reflect.get(fs, 'rmSync') as (file: string) => void;
    reached(file);
}

export async function viaExtraNames(dir: string): Promise<void> {
    await fse.remove(dir);
    fse.removeSync(dir);
    await fse.emptyDir(dir);
    fse.emptyDirSync(dir);
}

export class Janitor {
    sweep(file: string): void {
        fs.rmSync(file);
    }
}

// Round 4 (#181's A10 review, items 22 and 24): what the third review found
// the rail still missed, and the forms it can't resolve, which fail it closed.

export function viaGitOptions(dir: string, args: string[]): void {
    cp.execSync(`git -C ${dir} clean -fdx`);
    execFileSync('git', ['-C', dir, 'clean', '-fd']);
    execFileSync('git', args);
}

export function viaInterpreters(args: string[], code: string): void {
    spawnSync('bash', args);
    spawnSync('env', ['FOO=1', 'sh', '-c', code]);
    spawnSync('node', ['-e', code]);
    spawnSync('perl', ['-e', code]);
    spawnSync('python3', ['-c', code]);
    spawnSync('ls', [code], { shell: true });
}

export function viaRmFamily(): void {
    cp.execSync('\\rm -rf build');
    cp.execSync('"rm" -rf build');
    execFileSync('rmdir', ['build']);
    execFileSync('unlink', ['build/x']);
}

export async function viaIndirectProcess(command: string): Promise<void> {
    const { exec } = cp;
    exec(command);
    const loaded = await import('node:child_process');
    loaded.execSync('rm -rf x');
    const run = promisify(cp.exec);
    await run('rm -rf y');
}

export async function viaFsAliases(name: string): Promise<void> {
    const p = fs.promises;
    await p[name as 'rm']('x');
    const { promises } = fs;
    await promises[name as 'rm']('x');
    const { ['rm']: r } = fsp;
    await r('x');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the rail's positive control: a form it must catch
    Reflect.get(require('fs'), name);
}

export async function viaDynamicModule(name: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the rail's positive control: a form it must catch
    require(name);
    await import(name);
    const load = createRequire(import.meta.url);
    load('rimraf/dist/sync');
    createRequire(import.meta.url)('del');
}

export function viaHandOff(hand: (run: (command: string) => unknown) => void): void {
    hand(cp.execSync);
}

// Round 5 (#181's A10 review, item 27): the rail fails closed for real.

declare const disposable: { mkdtempDisposableSync(prefix: string): unknown; mkdtempDisposable(prefix: string): Promise<unknown> };

export function viaQuotedRm(dir: string): void {
    cp.execSync('bash -c "rm -rf build"');
    cp.execSync("eval 'rm -rf build'");
    cp.execSync(`sh -c \`rm -rf ${dir}\``);
}

export function viaProcessElement(name: 'exec'): void {
    cp['execSync']('rm -rf x');
    cp[name]('ls');
}

export function viaBuiltinLoaders(): void {
    process.getBuiltinModule('node:child_process').execSync('rm -rf x');
    module.require('node:child_process').execSync('rm -rf y');
    const load = require;
    load('node:child_process').execSync('rm -rf z');
}

export function viaEscapes(hand: (value: unknown) => void): unknown {
    hand(fs);
    void import('node:fs').then((loaded) => loaded.rmSync('x'));
    const copy = { ...cp };
    const alias: unknown = fsp;
    void copy;
    void alias;
    return fs.promises;
}

export { fsp as exportedFs };

export function viaStdin(): void {
    spawnSync('sh', [], { input: 'rm -rf x' });
    spawnSync('python3', ['script.py']);
}

export function viaOptions(file: string, options: object): void {
    spawnSync('ls', [file], options);
    spawnSync('ls', [file], { ...options });
    const shell = true;
    spawnSync('ls', [file], { shell });
}

export function viaNodeScript(): void {
    spawnSync('node', ['-e', "require('fs').rmSync('x')"]);
    spawnSync('node22', ['-e', 'require("fs").rmSync("x")']);
    spawnSync('node', ['-e', 'console.log(1)']);
}

export function viaInterpreterScripts(): void {
    spawnSync('perl', ['-e', 'print 1']);
    spawnSync('python', ['-c', 'print(1)']);
    spawnSync('python3.12', ['-c', 'print(1)']);
    spawnSync('ruby', ['-e', 'puts 1']);
    spawnSync('bun', ['-e', '1']);
    spawnSync('deno', ['eval', '1']);
}

export function viaEval(code: string): void {
    eval(code);
    void new Function(code);
    void new Worker(code, { eval: true });
}

export function viaMissingControls(name: 'rmSync' | 'unlinkSync', x: string): void {
    const { [name]: anything } = fs;
    void anything;
    spawnSync('sh', ['-c', 'echo "$1"', 'sh', x]);
}

export function viaWrappers(args: string[]): void {
    execFileSync('sudo', ['-u', 'root', 'git', 'clean', '-fd']);
    execFileSync('nice', ['-n', '10', 'git', 'clean', '-fd']);
    execFileSync('timeout', ['5', 'git', 'rm', '-r', 'x']);
    execFileSync('xargs', ['-0', 'git', 'worktree', 'remove']);
    execFileSync('npx', ['--yes', 'rimraf', 'build']);
    execFileSync('env', args);
    execFileSync('sudo', args);
    cp.execSync('npx rimraf build');
}

export async function viaDisposable(): Promise<void> {
    disposable.mkdtempDisposableSync('x');
    await disposable.mkdtempDisposable('y');
}
