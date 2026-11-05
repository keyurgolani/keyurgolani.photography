// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { mediaFilePath } from '../../media/path';
import { readHistory } from '../history';
import { historyArgs, historyLines, rollbackArgs, runHistoryCommand, runRollbackCommand, type RollbackArgs } from '../history-cli';
import { UsageError } from '../owner-cli';
import { publish } from '../publish';
import { listActivations, readRevisionFile } from '../repository';
import { planRollback, rollback, ROLLBACK_EXIT_CODES, VERIFY_FAILED_ACCEPT } from '../rollback';
import { registerRule } from '../rules';
import { createTestCatalog, type TestCatalog } from '../testing';
import { runVerifyCommand } from '../verify-cli';
import { verifyRecordPath } from '../verify';
import { authoredPaths, catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { VARIANT_BYTES } from './catalogFixtures';

/**
 * #181's A7: `photos history --json --limit --revisions`, and rollback
 * eligibility that reads `status/verify.json` the way rollbackReadiness()
 * does: a revision whose recorded verify failed, or any revision while the
 * record can't be read, is refused, in the CLI and in History, with a reason
 * that names `photos verify`. The CLI alone overrides it, with `--accept
 * verify.failed`, which the activation records. A passing `photos verify
 * --revision <id>` clears that revision's failure. Test values only.
 */

const cleanups: (() => Promise<void>)[] = [];

/** The revision test.eligibility-editorial reports an editorial error on while it's set. */
let editorialErrorOn: string | null = null;
registerRule({
    id: 'test.eligibility-editorial',
    version: 1,
    severity: 'error',
    gate: 'publish',
    rollbackClass: 'editorial',
    check: (ctx) => (editorialErrorOn !== null && ctx.authored === null && ctx.active?.revisionId === editorialErrorOn
        ? [{ record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds', message: 'A test editorial error.' }]
        : []),
});

afterEach(async () => {
    editorialErrorOn = null;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined };

interface Two {
    catalog: TestCatalog;
    root: string;
    one: string;
    two: string;
}

/** Revision 1, then revision 2 with one caption changed. Revision 2 is live. */
async function twoRevisions(seed: number): Promise<Two> {
    const catalog = await createTestCatalog({ seed, photos: 3, series: 1, variantBytes: VARIANT_BYTES });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const first = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet });
    const photo = (await readWorkingLayer(root)).photos[0];
    await writeAuthoredRecord({ ...photo, caption: 'A caption revision 2 publishes.' }, { expectedVersion: photo.version, root });
    const second = await publish({ dataRoot: root, actor: 'test', logger: quiet });
    if (first.outcome !== 'PUBLISHED' || second.outcome !== 'PUBLISHED') throw new Error(`Publishing ended ${first.outcome} and ${second.outcome}.`);
    return { catalog, root, one: first.revisionId ?? '', two: second.revisionId ?? '' };
}

function io(answer: boolean | null = null) {
    const lines: string[] = [];
    const errors: string[] = [];
    const asked: string[] = [];
    return {
        lines,
        errors,
        asked,
        out: (line: string) => lines.push(line),
        err: (line: string) => errors.push(line),
        confirm: answer === null ? null : async (question: string) => {
            asked.push(question);
            return answer;
        },
        logger: quiet,
        all: () => [...lines, ...errors].join('\n'),
    };
}

/** A full `photos verify` run, which records, then `revisionId`'s entry marked failed, as a run that saw a broken set would leave it. */
async function recordFailure(root: string, revisionId: string, problem = 'ph_x: w800.webp does not match its sha256'): Promise<void> {
    const out = io();
    expect(await runVerifyCommand(root, { json: false }, out)).toBe(0);
    markFailed(root, revisionId, problem);
}

/** `revisionId`'s entry in the record there is marked failed, with no new run, so two entries can fail at once. */
function markFailed(root: string, revisionId: string, problem: string): void {
    const file = verifyRecordPath(root);
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { revisions: { revisionId: string; ok: boolean; problems: string[]; problemCount: number }[] };
    const entry = record.revisions.find((candidate) => candidate.revisionId === revisionId);
    if (!entry) throw new Error(`The record has no entry for ${revisionId}.`);
    Object.assign(entry, { ok: false, problems: [problem], problemCount: 1 });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** The catalog, the working layer, and the locks, so a refused rollback shows it wrote nothing. */
const untouched = (root: string) => ({ catalog: folderBytes(catalogPaths(root).dir), authored: folderBytes(authoredPaths(root).dir), locks: folderBytes(path.join(root, 'locks')) });

const usage = (run: () => unknown): string => {
    try {
        run();
    } catch (error) {
        if (error instanceof UsageError) return error.message;
        throw error;
    }
    throw new Error('No usage error.');
};

describe('photos history flags', { timeout: 60_000 }, () => {
    it('parses --json, --limit <n> and --revisions, none by default, and refuses a bad limit or a repeat', () => {
        expect(historyArgs([])).toEqual({ json: false, limit: null, revisions: false });
        expect(historyArgs(['--json', '--limit', '3', '--revisions'])).toEqual({ json: true, limit: 3, revisions: true });
        expect(usage(() => historyArgs(['--limit', '0']))).toBe('--limit takes a number of activations from 1, not 0.');
        expect(usage(() => historyArgs(['--limit', 'all']))).toBe('--limit takes a number of activations from 1, not all.');
        expect(usage(() => historyArgs(['--limit', '2', '--limit', '3']))).toBe('--limit is given more than once. Give it once.');
        expect(() => historyArgs(['--since', 'x'])).toThrow(UsageError);
    });

    it('--limit shows the newest n activations, still oldest first, and says how many it left out', async () => {
        const { root, two } = await twoRevisions(711);
        const result = await runHistoryCommand(root, { json: false, limit: 1, revisions: false });
        expect(result.exitCode).toBe(0);
        const lines = result.output.trimEnd().split('\n');
        expect(lines[0]).toBe(`[photos] 2 activations, oldest first, showing the newest 1. Live: revision 2, ${two}, from #2.`);
        expect(result.output).toMatch(/^#2 revision 2: publish, committed, LIVE$/m);
        expect(result.output).not.toMatch(/^#1 /m);
        // No flags: what it printed before.
        const plain = await runHistoryCommand(root);
        expect(plain.output.split('\n')[0]).toBe(`[photos] 2 activations, oldest first. Live: revision 2, ${two}, from #2.`);
        expect(plain.output).toMatch(/^#1 revision 1: publish, committed$/m);
    });

    it('--revisions prints each revision once, newest first, with its rollback eligibility and reasons', async () => {
        const { root, one, two } = await twoRevisions(712);
        editorialErrorOn = one;
        const result = await runHistoryCommand(root, { json: false, limit: null, revisions: true });
        expect(result.exitCode, result.output).toBe(0);
        const lines = result.output.trimEnd().split('\n');
        const at = lines.indexOf('[photos] Rollback eligibility, newest first:');
        expect(at).toBeGreaterThan(0);
        expect(lines.slice(at + 1)).toEqual([
            `revision 2, ${two}: LIVE, so there is nothing to roll back to.`,
            `revision 1, ${one}: a rollback can return to it with --accept for each editorial error: test.eligibility-editorial.`,
        ]);

        // A recorded failure: refused, with both accepts it needs, and the reason, which names photos verify.
        await recordFailure(root, one);
        const failed = (await runHistoryCommand(root, { json: false, limit: null, revisions: true })).output.trimEnd().split('\n');
        expect(failed.slice(failed.indexOf('[photos] Rollback eligibility, newest first:') + 2)).toEqual([
            `revision 1, ${one}: VERIFY_FAILED, so a rollback returns to it only with --accept test.eligibility-editorial --accept verify.failed.`,
            `    Revision 1 (${one}) failed its last photos verify: ph_x: w800.webp does not match its sha256. Fix it and run photos verify --revision ${one}, or accept it with --accept verify.failed.`,
        ]);
        // --limit 1 shows only the live activation, so only its revision.
        const limited = (await runHistoryCommand(root, { json: false, limit: 1, revisions: true })).output;
        expect(limited).toContain(`revision 2, ${two}: LIVE`);
        expect(limited).not.toContain(`revision 1, ${one}:`);
    });

    it('--json prints the rows, and with --revisions the eligibility, in a versioned shape with no absolute path', async () => {
        const { root, one, two } = await twoRevisions(713);
        await recordFailure(root, one);
        const result = await runHistoryCommand(root, { json: true, limit: null, revisions: true });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).not.toContain(root);
        const out = JSON.parse(result.output) as Record<string, unknown> & { rows: Record<string, unknown>[]; revisions: Record<string, unknown>[] };
        expect(out).toMatchObject({ schemaVersion: 1, total: 2, shown: 2, pointer: { revisionId: two, activationId: expect.stringMatching(/^act_/) } });
        expect(out.rows.map((row) => [row.sequence, row.revisionNumber, row.kind, row.state, row.live])).toEqual([
            [1, 1, 'publish', 'committed', false],
            [2, 2, 'publish', 'committed', true],
        ]);
        expect(out.rows[1]).toMatchObject({ revisionId: two, actor: 'test', acceptedRules: [], summary: { seriesCount: 1, photoCount: 3 } });
        expect(out.revisions).toEqual([
            { revisionId: two, revisionNumber: 2, live: true, eligible: false, outcome: 'NO_CHANGES', reasons: [], accept: [] },
            {
                revisionId: one,
                revisionNumber: 1,
                live: false,
                eligible: false,
                outcome: 'VERIFY_FAILED',
                reasons: [expect.stringContaining('photos verify')],
                accept: [VERIFY_FAILED_ACCEPT],
            },
        ]);
        // Without --revisions, the key is absent; --limit trims the rows.
        const trimmed = JSON.parse((await runHistoryCommand(root, { json: true, limit: 1, revisions: false })).output) as Record<string, unknown> & { rows: unknown[] };
        expect(trimmed).toMatchObject({ total: 2, shown: 1 });
        expect(trimmed.rows).toHaveLength(1);
        expect('revisions' in trimmed).toBe(false);
    });
});

describe('rollback eligibility reads the verify record', { timeout: 60_000 }, () => {
    it('refuses a revision whose recorded verify failed, VERIFY_FAILED, exit 1, naming photos verify, writing nothing', async () => {
        const { root, one, two } = await twoRevisions(721);
        await recordFailure(root, one);
        const plan = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(plan).toMatchObject({ outcome: 'VERIFY_FAILED', target: { revisionId: one, revisionNumber: 1 }, active: { revisionId: two }, blocking: [], verify: { reason: 'last-verify', problems: ['ph_x: w800.webp does not match its sha256'] } });
        expect(plan.message).toBe(`Revision 1 (${one}) failed its last photos verify: ph_x: w800.webp does not match its sha256. Fix it and run photos verify --revision ${one}, or accept it with --accept verify.failed. Nothing was rolled back.`);
        // Still an impact list, so the CLI can show what an override would do.
        expect(plan.impact?.photos.changed).toHaveLength(1);
        expect(ROLLBACK_EXIT_CODES.VERIFY_FAILED).toBe(1);

        const before = untouched(root);
        const result = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', logger: quiet });
        expect(result).toMatchObject({ outcome: 'VERIFY_FAILED', activation: null });
        expect(untouched(root)).toEqual(before);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
    });

    it('rolls back with --accept verify.failed and records it in acceptedRules, which history prints', async () => {
        const { root, one, two } = await twoRevisions(722);
        await recordFailure(root, one);
        const result = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: [VERIFY_FAILED_ACCEPT], logger: quiet });
        expect(result.outcome, result.message).toBe('ROLLED_BACK');
        expect(result.activation?.acceptedRules).toEqual([VERIFY_FAILED_ACCEPT]);
        expect(historyLines(await readHistory(root)).join('\n')).toContain('    Accepted a failed photos verify: verify.failed');
    });

    it('needs every accept when the target carries an editorial error and a verify failure, and records both', async () => {
        const { root, one, two } = await twoRevisions(723);
        editorialErrorOn = one;
        await recordFailure(root, one);
        const editorialOnly = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: ['test.eligibility-editorial'], logger: quiet });
        expect(editorialOnly.outcome).toBe('VERIFY_FAILED');
        const verifyOnly = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: [VERIFY_FAILED_ACCEPT], logger: quiet });
        expect(verifyOnly).toMatchObject({ outcome: 'ACCEPTANCE_REQUIRED', unaccepted: ['test.eligibility-editorial'] });
        const both = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: [VERIFY_FAILED_ACCEPT, 'test.eligibility-editorial'], logger: quiet });
        expect(both.outcome).toBe('ROLLED_BACK');
        expect(both.activation?.acceptedRules).toEqual(['test.eligibility-editorial', VERIFY_FAILED_ACCEPT]);
    });

    it('refuses every revision while the record is damaged, fail-safe, as rollbackReadiness() reads it', async () => {
        const { root, one, two } = await twoRevisions(724);
        expect(await runVerifyCommand(root, { json: false }, io())).toBe(0);
        fs.writeFileSync(verifyRecordPath(root), '{"schemaVersion": 1, "revisions": ');
        const plan = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(plan).toMatchObject({ outcome: 'VERIFY_FAILED', verify: { reason: 'record-damaged', problems: [] } });
        expect(plan.message).toBe(`status/verify.json can't be read, so nothing shows whether revision 1 (${one}) passed its last photos verify. Run photos verify to record a new check, or accept it with --accept verify.failed. Nothing was rolled back.`);
        const result = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', logger: quiet });
        expect(result.outcome).toBe('VERIFY_FAILED');
    });

    it('allows a revision with no record, and one the record passes', async () => {
        const { root } = await twoRevisions(725);
        expect(fs.existsSync(verifyRecordPath(root))).toBe(false);
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).toMatchObject({ outcome: 'READY', verify: null });
        expect(await runVerifyCommand(root, { json: false }, io())).toBe(0);
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).toMatchObject({ outcome: 'READY', verify: null });
    });

    it('still refuses a damaged revision file with INTEGRITY_MISMATCH first, whatever the record says or it accepts', async () => {
        const { root, one, two } = await twoRevisions(726);
        await recordFailure(root, one);
        fs.writeFileSync(path.join(catalogPaths(root).revisionsDir, `${one}.json`), '{ not json');
        const result = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: [VERIFY_FAILED_ACCEPT], logger: quiet });
        expect(result.outcome).toBe('INTEGRITY_MISMATCH');
    });

    it('still refuses an integrity error with VALIDATION_FAILED before the record, and --accept verify.failed never lifts it', async () => {
        const { root, one, two } = await twoRevisions(729);
        await recordFailure(root, one);
        // A variant one byte longer than its manifest says: assets.size, an integrity rule, on both revisions' shared set.
        const photo = (await readRevisionFile(root, one))?.content.photos[0];
        if (!photo) throw new Error('Revision 1 has no photo.');
        fs.appendFileSync(mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, 'w800', 'webp', root), 'x');
        const plan = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(plan).toMatchObject({ outcome: 'VALIDATION_FAILED', verify: null });
        const before = untouched(root);
        const result = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'back', acceptedRules: [VERIFY_FAILED_ACCEPT], logger: quiet });
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(untouched(root)).toEqual(before);
    });

    it('clears a recorded failure with a passing photos verify --revision, and leaves every other entry as it was', async () => {
        const { root, one, two } = await twoRevisions(727);
        await recordFailure(root, one);
        markFailed(root, two, 'two: a problem another run saw');
        const read = () => JSON.parse(fs.readFileSync(verifyRecordPath(root), 'utf8')) as { checkedAt: string; revisions: { revisionId: string; ok: boolean; checkedAt?: string }[] };
        const before = read();

        const single = io();
        expect(await runVerifyCommand(root, { json: false, revisionId: one }, single)).toBe(0);
        expect(single.lines).toContain(`Recorded: revision 1 passes now, so status/verify.json no longer fails it.`);
        const after = read();
        expect(after.checkedAt).toBe(before.checkedAt);
        expect(after.revisions.find((entry) => entry.revisionId === one)).toMatchObject({ ok: true, checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
        expect(after.revisions.find((entry) => entry.revisionId === two)).toEqual(before.revisions.find((entry) => entry.revisionId === two));
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).toMatchObject({ outcome: 'READY', verify: null });
    });

    it('records nothing on a --revision pass with no record or no failure to clear, nor on a damaged record', async () => {
        const { root, one } = await twoRevisions(728);
        const none = io();
        expect(await runVerifyCommand(root, { json: false, revisionId: one }, none)).toBe(0);
        expect(fs.existsSync(verifyRecordPath(root))).toBe(false);
        expect(none.lines).toContain('Nothing was recorded: --revision checks one revision, without the activation chain, and records only a pass that clears a recorded failure.');

        expect(await runVerifyCommand(root, { json: false }, io())).toBe(0);
        const clean = fs.readFileSync(verifyRecordPath(root), 'utf8');
        expect(await runVerifyCommand(root, { json: false, revisionId: one }, io())).toBe(0);
        expect(fs.readFileSync(verifyRecordPath(root), 'utf8')).toBe(clean);

        fs.writeFileSync(verifyRecordPath(root), '{ damaged');
        const damaged = io();
        expect(await runVerifyCommand(root, { json: false, revisionId: one }, damaged)).toBe(0);
        expect(fs.readFileSync(verifyRecordPath(root), 'utf8')).toBe('{ damaged');
        expect(damaged.lines).toContain("[photos] status/verify.json can't be read, so this pass cleared nothing. Run photos verify without --revision to record a full check.");
    });
});

describe('photos rollback --accept verify.failed', { timeout: 60_000 }, () => {
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'back', actor: 'curator', accept: [], yes: false, ...overrides });

    it('takes verify.failed as an accept, beside the editorial rule IDs', () => {
        expect(rollbackArgs(['--to', '1', '--reason', 'r', '--actor', 'a', '--accept', 'verify.failed']).accept).toEqual(['verify.failed']);
        expect(usage(() => rollbackArgs(['--to', '1', '--reason', 'r', '--actor', 'a', '--accept', 'verify.fail']))).toMatch(/^--accept takes an editorial rule ID \(.+\) or verify\.failed, not verify\.fail\.$/);
    });

    it('refuses before it asks without the accept, then rolls back with --yes --expect-active --accept verify.failed', async () => {
        const { root, one, two } = await twoRevisions(731);
        await recordFailure(root, one);
        const before = untouched(root);
        const terminal = io(true);
        expect(await runRollbackCommand(root, args(), terminal)).toBe(1);
        expect(terminal.asked).toEqual([]);
        expect(terminal.errors[0]).toMatch(/^\[photos\] VERIFY_FAILED: Revision 1 \(rev_[0-9a-f]{64}\) failed its last photos verify: /);
        expect(terminal.all()).toContain(`Target: ${one}, revision 1`);
        expect(untouched(root)).toEqual(before);

        const headless = io(null);
        expect(await runRollbackCommand(root, args({ accept: [VERIFY_FAILED_ACCEPT] }), headless)).toBe(3);
        expect(headless.lines).toContain('Accepted: its last photos verify failed (verify.failed). The activation records that you accepted it.');
        expect(headless.errors.at(-1)).toContain(`--yes --expect-active ${two} --accept verify.failed`);

        const confirmed = io(null);
        expect(await runRollbackCommand(root, args({ accept: [VERIFY_FAILED_ACCEPT], yes: true, expectActive: two }), confirmed)).toBe(0);
        expect((await listActivations(root)).at(-1)).toMatchObject({ kind: 'rollback', revisionId: one, acceptedRules: [VERIFY_FAILED_ACCEPT] });
    });

    it("says verify.failed isn't flagged on a target the record passes, and doesn't record it", async () => {
        const { root, one, two } = await twoRevisions(732);
        const out = io(null);
        expect(await runRollbackCommand(root, args({ accept: [VERIFY_FAILED_ACCEPT], yes: true, expectActive: two }), out)).toBe(0);
        expect(out.lines).toContain("verify.failed isn't flagged on revision 1: no photos verify has failed it, so there's nothing to accept.");
        expect((await listActivations(root)).at(-1)).toMatchObject({ revisionId: one, acceptedRules: [] });
    });
});
