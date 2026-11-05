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
    Reflect.get(require('fs'), name);
}

export async function viaDynamicModule(name: string): Promise<void> {
    require(name);
    await import(name);
    const load = createRequire(import.meta.url);
    load('rimraf/dist/sync');
    createRequire(import.meta.url)('del');
}
