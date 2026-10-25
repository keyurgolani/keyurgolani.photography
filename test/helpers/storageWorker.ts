/**
 * A separate process for storage tests that need real contention or a real
 * crash. Run as `node --import tsx test/helpers/storageWorker.ts <command> <json>`.
 *
 * - `lock {root, name, leaseMs, waitMs, holdMs, log, id, startAt}` waits until
 *   `startAt`, takes the lock, appends `enter <id> <previousOwner|->` and
 *   `exit <id>` to `log` around a `holdMs` hold, and prints its takeover.
 * - `crash-write {file, content}` starts an atomic write and SIGKILLs itself
 *   just before the rename, the way a power cut would.
 * - `crash-version {dir, value, expected}` starts a versioned write and
 *   SIGKILLs itself once its temp is staged, before the link.
 */

import fs from 'node:fs';
import { atomicWriteFile } from '../../lib/storage/atomicWrite';
import { writeVersionedDocument, type VersionedDocument } from '../../lib/storage/document';
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

async function crashVersion(args: { dir: string; value: VersionedDocument; expected: number }): Promise<void> {
    await writeVersionedDocument(args.dir, args.value, args.expected, {
        hooks: {
            afterStage() {
                process.kill(process.pid, 'SIGKILL');
            },
        },
    });
}

const commands: Record<string, (args: never) => Promise<void>> = { lock, 'crash-write': crashWrite, 'crash-version': crashVersion };

const [command, json] = process.argv.slice(2);
const args = JSON.parse(json ?? '{}') as never;
const run = command in commands ? commands[command](args) : Promise.reject(new Error(`Unknown command ${command}`));
run.catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
