import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface TsxRun {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

/** Run a repository TypeScript file under tsx in a child process, the way the npm scripts do. */
export function runTsx(script: string, args: string[], { env = {} }: { env?: Record<string, string | undefined> } = {}): Promise<TsxRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}
