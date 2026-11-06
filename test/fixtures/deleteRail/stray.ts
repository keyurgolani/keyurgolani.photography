/**
 * The delete rail's positive control (test/deleteRail.test.ts): a module
 * with a stray delete in each form the rail looks for. Nothing imports or
 * runs it.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';

export async function tidyUp(dir: string): Promise<void> {
    await fs.promises.rm(dir, { recursive: true, force: true });
}

export function tidyUpSync(file: string): void {
    fs.unlinkSync(file);
    fs['rmSync'](file);
}

export const viaImport = (dir: string) => rm(dir, { recursive: true });

export function viaShell(dir: string): void {
    execSync(`rm -rf ${dir}`);
    spawn('rm', ['-rf', dir]);
    spawn('find', [dir, '-name', '*.tmp', '-delete']);
}

export const passedOn = (files: string[]) => Promise.all(files.map(fs.promises.unlink));
