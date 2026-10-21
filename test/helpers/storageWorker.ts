/**
 * A separate process for storage tests that need real contention or a real
 * crash. Run as `node --import tsx test/helpers/storageWorker.ts <command> <json>`.
 *
 * - `lock {root, name, leaseMs, waitMs, holdMs, log, id, startAt}` waits until
 *   `startAt`, takes the lock, appends `enter <id> <previousOwner|->` and
 *   `exit <id>` to `log` around a `holdMs` hold, and prints its takeover.
 * - `crash-write {file, content}` starts an atomic write and SIGKILLs itself
 *   just before the rename, the way a power cut would.
 */

import fs from 'node:fs';
import { atomicWriteFile } from '../../lib/storage/atomicWrite';
import { withLock } from '../../lib/storage/lock';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LockArgs {
    root: string;
    name: string;
    leaseMs: number;
    waitMs: number;
    holdMs: number;
    log: string;
    id: string;
    startAt: number;
}

async function lock(args: LockArgs): Promise<void> {
    await sleep(Math.max(0, args.startAt - Date.now()));
    const takeover = await withLock(args.name, { root: args.root, leaseMs: args.leaseMs, waitMs: args.waitMs }, async (context) => {
        fs.appendFileSync(args.log, `enter ${args.id} ${context.takeover?.previousOwner ?? '-'}\n`);
        await sleep(args.holdMs);
        fs.appendFileSync(args.log, `exit ${args.id}\n`);
        return context.takeover;
    });
    process.stdout.write(`${JSON.stringify({ id: args.id, takeover })}\n`);
}

async function crashWrite(args: { file: string; content: string }): Promise<void> {
    await atomicWriteFile(args.file, args.content, {
        faults: {
            beforeRename() {
                process.kill(process.pid, 'SIGKILL');
            },
        },
    });
}

const [command, json] = process.argv.slice(2);
const args = JSON.parse(json ?? '{}');
const run = command === 'lock' ? lock(args as LockArgs) : command === 'crash-write' ? crashWrite(args) : Promise.reject(new Error(`Unknown command ${command}`));
run.catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
