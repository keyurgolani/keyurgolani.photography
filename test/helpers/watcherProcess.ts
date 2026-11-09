import { spawn, type ChildProcess } from 'node:child_process';
import { REPO_ROOT } from './runTsx';

/**
 * `scripts/imageWatcher.ts` in a child process, the way `npm run
 * images:process` and `images:watch` start it, for the spawned watcher tests
 * (utils/__tests__/imageWatcherScript.test.ts) and #8's `--watch` order row
 * (lib/catalog/__tests__/orderInvariance.test.ts). Call killWatchers() after
 * each test.
 */

const children: ChildProcess[] = [];

/** SIGKILL every watcher a test started that is still running. */
export function killWatchers(): void {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
}

export function spawnWatcher(args: string[], env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/imageWatcher.ts', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
    });
    children.push(child);
    let output = '';
    const onOutput: (() => void)[] = [];
    const collect = (chunk: Buffer) => {
        output += chunk.toString();
        onOutput.forEach((check) => check());
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });

    return {
        child,
        exited,
        get output() {
            return output;
        },
        /** Resolve once the output contains `text`. */
        waitFor(text: string, timeoutMs = 60_000): Promise<void> {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`No "${text}" within ${timeoutMs} ms:\n${output}`)), timeoutMs);
                const check = () => {
                    if (output.includes(text)) {
                        clearTimeout(timer);
                        resolve();
                    }
                };
                onOutput.push(check);
                check();
                void exited.then(() => {
                    clearTimeout(timer);
                    if (!output.includes(text)) reject(new Error(`Exited before "${text}":\n${output}`));
                });
            });
        },
    };
}

/** Poll `check` every 500 ms until it holds, or throw after `timeoutMs` with the watcher's output. */
export async function waitUntil(check: () => boolean, timeoutMs: number, what: string, output: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms:\n${output()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
