/**
 * The delete rail's second positive control (test/deleteRail.test.ts, #181's
 * A10 review item 16): each form the second review found the rail missed.
 * Nothing imports or runs it.
 */

import * as cp from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

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
