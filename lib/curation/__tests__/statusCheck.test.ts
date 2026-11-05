// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStatusCommand } from '../../catalog/owner-status';
import { watcherStatusFile, writeWatcherHeartbeat, type PassResult, type WatcherHeartbeat } from '../../identity/heartbeat';
import { versionFile } from '../../storage/document';
import type { IdentityFact } from '../../identity/types';
import { eventIdOf, eventKey, type CurationEventType } from '../events';
import { eventDir, readEvent, withCurationLock, writeEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, type CurationFixture } from './curationFixtures';

/**
 * #14 and #17 (v2.0.0, A2): `photos status` counts what needs review and
 * what is open, and `--check` is the monitor's exit code on today's event
 * types: 1 on an open missing, failed, or ambiguous item, on a failed last
 * pass, or on a heartbeat over 5 minutes old, and 0 otherwise.
 */

// readWorkingLayer(), wrapped, so a test can make status itself throw.
const crash = vi.hoisted(() => ({ on: false }));
vi.mock('../../catalog/working-layer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../catalog/working-layer')>();
    return {
        ...actual,
        readWorkingLayer: async (...args: Parameters<typeof actual.readWorkingLayer>) => {
            if (crash.on) throw new Error('Fixture crash reading the working layer');
            return actual.readWorkingLayer(...args);
        },
    };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    crash.on = false;
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
/** Three hours after the fixture's facts were observed (curationFixtures.ts). */
const NOW = Date.parse('2026-02-01T03:00:00.000Z');
const clock = () => NOW;
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

const TYPE_OF: Partial<Record<IdentityFact['type'], CurationEventType>> = { new: 'new', missing: 'missing', ambiguous: 'ambiguous', 'processing-failed': 'processing-failure' };

async function fixture(): Promise<CurationFixture> {
    const f = await createCurationFixture({ published: true });
    cleanups.push(() => f.cleanup());
    return f;
}

async function deliver(f: CurationFixture, facts: IdentityFact[]): Promise<string[]> {
    await createCurationSink({ root: f.root, logger: quiet })(facts);
    return facts.map((fact) => eventIdOf(eventKey(TYPE_OF[fact.type] as CurationEventType, fact)));
}

/** The watcher's heartbeat, `ageMs` before NOW, with its last pass's result, and anything else a test sets. */
const beat = (f: CurationFixture, ageMs: number, lastPassResult: PassResult | null = 'committed', extra: Partial<WatcherHeartbeat> = {}) =>
    writeWatcherHeartbeat(f.root, { pid: 1, hostname: 'fixture', lastPassAt: lastPassResult === null ? null : iso(NOW - ageMs), lastPassResult, passStartedAt: null, heartbeatAt: iso(NOW - ageMs), lastProgressAt: iso(NOW - ageMs), legacyDerivatives: false, ...extra });

const status = (f: CurationFixture, options: { check?: boolean; json?: boolean } = {}) => runStatusCommand({ dataRoot: f.root }, { ...options, clock });

const missingFact = (f: CurationFixture) => f.fact('missing', f.catalog.photos[0].id);
const failedFact = (f: CurationFixture) => f.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/unbound.heic' });
const ambiguousFact = (f: CurationFixture) => f.fact('ambiguous', null, { candidates: [f.fresh[1], f.catalog.photos[1].id], path: 'trips/copy.jpg' });

describe('photos status counts', () => {
    it('counts needs-review, missing, failed, ambiguous, and stale items, and prints each missing source with its age', async () => {
        const f = await fixture();
        await beat(f, 30_000);
        const [, missingId, , ambiguousId] = await deliver(f, [f.fact('new', f.fresh[0]), missingFact(f), failedFact(f), ambiguousFact(f)]);
        const { exitCode, output } = await status(f);
        // Without --check, open items don't fail status.
        expect(exitCode).toBe(0);
        expect(output).toContain('Inbox: 4 need review, 1 missing source, 1 failure, 1 ambiguous, 0 stale');
        expect(output).toMatch(new RegExp(`\\n  missing  ph_[0-9a-f]{8}  [^\\n]+  since 2026-02-01T00:00:00\\.000Z, 3 h ago, open; [^\\n]+\\(${missingId}@1\\)\\n`));
        expect(output).toMatch(new RegExp(`\\n  ambiguous  no photo ID  trips/copy\\.jpg  since 2026-02-01T00:00:00\\.000Z, 3 h ago, open  \\(${ambiguousId}@1\\)\\n`));
        expect(output).not.toContain('Check:');

        const json = JSON.parse((await status(f, { json: true })).output) as { inbox: { counts: unknown; missing: { ageSeconds: number }[] } };
        expect(json.inbox.counts).toEqual({ needsReview: 4, missing: 1, held: 0, failed: 1, ambiguous: 1, stale: 0 });
        expect(json.inbox.missing[0].ageSeconds).toBe(3 * 3600);
    });

    it('counts an approval no series holds any more as stale, and names it', async () => {
        const f = await fixture();
        await beat(f, 30_000);
        const [id] = await deliver(f, [f.fact('new', f.fresh[0])]);
        const event = (await readEvent(f.root, id))!;
        // Approved into the draft series, which no longer lists the photo, as after a rollback or a `sequence remove`.
        const approve = { action: 'approve' as const, at: '2026-02-01T01:00:00.000Z', by: 'fixture', baseRevisionId: null, seriesId: DRAFT };
        await withCurationLock(f.root, {}, (hold) => writeEvent(f.root, { ...event, status: 'approved', decisions: [approve] }, event.version, hold));
        const { output } = await status(f);
        expect(output).toContain('Inbox: 0 need review, 0 missing sources, 0 failures, 0 ambiguous, 1 stale');
        expect(output).toMatch(new RegExp(`\\n  stale    ph_[0-9a-f]{8}  trips/harbor-1\\.jpg  since 2026-02-01T00:00:00\\.000Z, approved into ${DRAFT}, but no series or the live revision holds it now  \\(${id}@2\\)\\n`));
        // A stale approval is for the curator to place again, not the monitor's to page on.
        expect((await status(f, { check: true })).exitCode).toBe(0);
    });
});

describe('photos status --check', () => {
    it('exits 0 on an empty inbox and a fresh heartbeat, and says so', async () => {
        const f = await fixture();
        await beat(f, 30_000);
        const result = await status(f, { check: true });
        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/\nCheck: passed\.\n$/);
    });

    it('exits 0 while only new photographs wait for review', async () => {
        const f = await fixture();
        await beat(f, 30_000);
        await deliver(f, [f.fact('new', f.fresh[0])]);
        const result = await status(f, { check: true });
        expect(result.output).toContain('Inbox: 1 needs review, 0 missing sources, 0 failures, 0 ambiguous, 0 stale');
        expect(result.exitCode).toBe(0);
    });

    it.each([
        ['missing', missingFact, '1 missing source open, the oldest 3 h old'],
        ['failed', failedFact, '1 failure open'],
        ['ambiguous', ambiguousFact, '1 ambiguous item open'],
    ] as const)('exits 1 on an open %s item, and says why', async (_name, fact, why) => {
        const f = await fixture();
        await beat(f, 30_000);
        await deliver(f, [fact(f)]);
        const result = await status(f, { check: true });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(`\nCheck: failed.\n  - ${why}.`);
    });

    it('exits 1 on a failed last pass', async () => {
        const f = await fixture();
        await beat(f, 30_000, 'failed');
        const result = await status(f, { check: true });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(`  - The watcher's last pass failed, at ${iso(NOW - 30_000)}.`);
    });

    it('exits 1 on no heartbeat, or one over 5 minutes old, either way', async () => {
        const f = await fixture();
        const none = await status(f, { check: true });
        expect(none.exitCode).toBe(1);
        expect(none.output).toContain("  - The watcher hasn't written a heartbeat, so nothing shows it runs.");

        await beat(f, 5 * MINUTE);
        expect((await status(f, { check: true })).exitCode).toBe(0);
        await beat(f, 5 * MINUTE + 1_000);
        const stale = await status(f, { check: true });
        expect(stale.exitCode).toBe(1);
        expect(stale.output).toContain(`  - The watcher's heartbeat is 5 min old, over 5 minutes, at ${iso(NOW - 5 * MINUTE - 1_000)}.`);
        // Stamped ahead of this clock: after a clock step back, a dead watcher would look alive.
        await beat(f, -6 * MINUTE);
        const ahead = await status(f, { check: true });
        expect(ahead.exitCode).toBe(1);
        expect(ahead.output).toContain(`  - The watcher's heartbeat is stamped 6 min ahead of this clock, at ${iso(NOW + 6 * MINUTE)}.`);
    });

    it('prints the check in --json, with a code for each problem', async () => {
        const f = await fixture();
        await beat(f, 10 * MINUTE, 'failed');
        await deliver(f, [missingFact(f), failedFact(f), ambiguousFact(f)]);
        const result = await status(f, { check: true, json: true });
        expect(result.exitCode).toBe(1);
        const json = JSON.parse(result.output) as { check: { ok: boolean; problems: { code: string; message: string }[] } };
        expect(json.check.ok).toBe(false);
        expect(json.check.problems.map((problem) => problem.code)).toEqual(['missing-open', 'failed-open', 'ambiguous-open', 'last-pass-failed', 'heartbeat-stale']);
        // Without --check, the JSON keeps its shape.
        expect(Object.keys(JSON.parse((await status(f, { json: true })).output))).toEqual(['identity', 'catalog', 'working', 'inbox']);
    });

    it('exits 1 when the data root is not set, as status does', async () => {
        const result = await runStatusCommand({ dataRoot: null }, { check: true, clock });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('\nCheck: failed.\n');
    });
});

describe('photos status --check, after the review (v2.0.0 A2)', () => {
    it("exits 1 when an inbox item can't be read, since it may be an open missing source", async () => {
        const f = await fixture();
        await beat(f, 30_000);
        const [id] = await deliver(f, [missingFact(f)]);
        // The open missing item's only version, cut short, as a full disk or a torn copy leaves it.
        fs.writeFileSync(versionFile(eventDir(f.root, id), 1), '{"schemaVersion": 1, "id": ');
        const result = await status(f, { check: true });
        expect(result.output).toContain('Inbox: 0 need review, 0 missing sources, 0 failures, 0 ambiguous, 0 stale, 1 item unreadable (curation list names them)');
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("  - 1 inbox item can't be read, so the check can't tell what it holds. curation list names it.");
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { problems: { code: string }[] } };
        expect(json.check.problems.map((problem) => problem.code)).toEqual(['inbox-unreadable']);
    });

    it('prints JSON in the check\'s shape, and exits 1, when status itself fails under --json', async () => {
        const f = await fixture();
        await beat(f, 30_000);
        crash.on = true;
        const checked = await status(f, { check: true, json: true });
        expect(checked.exitCode).toBe(1);
        expect(JSON.parse(checked.output)).toEqual({
            error: 'Fixture crash reading the working layer',
            check: { ok: false, problems: [{ code: 'status-incomplete', message: "Status couldn't run: Fixture crash reading the working layer" }] },
        });
        const plain = await status(f, { json: true });
        expect(plain.exitCode).toBe(1);
        expect(JSON.parse(plain.output)).toEqual({ error: 'Fixture crash reading the working layer' });
        // The text forms stay text.
        expect((await status(f, { check: true })).output).toBe("Error: Fixture crash reading the working layer\nCheck: failed.\n  - Status couldn't run: Fixture crash reading the working layer.\n");
    });

    it('exits 1 when a watcher that still beats has finished no pass for over 30 minutes: always locked', async () => {
        const f = await fixture();
        // Beating every 30 s and trying a pass, but the registry stays busy, so no pass gets through.
        await beat(f, 30_000, 'locked', { lastProgressAt: iso(NOW - 29 * MINUTE) });
        expect((await status(f, { check: true })).exitCode).toBe(0);
        await beat(f, 30_000, 'locked', { lastProgressAt: iso(NOW - 31 * MINUTE) });
        const stalled = await status(f, { check: true });
        expect(stalled.exitCode).toBe(1);
        expect(stalled.output).toContain(`  - The watcher has finished no pass for 31 min, over 30 minutes, since ${iso(NOW - 31 * MINUTE)}; its last try was locked.`);
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { problems: { code: string }[] } };
        expect(json.check.problems.map((problem) => problem.code)).toEqual(['pass-stalled']);
    });

    it('exits 1 when one pass has run for over 30 minutes, and the heartbeat still beats', async () => {
        const f = await fixture();
        await beat(f, 30_000, 'committed', { lastPassAt: iso(NOW - 45 * MINUTE), lastProgressAt: iso(NOW - 45 * MINUTE), passStartedAt: iso(NOW - 40 * MINUTE) });
        const stalled = await status(f, { check: true });
        expect(stalled.exitCode).toBe(1);
        expect(stalled.output).toContain(`  - The watcher has finished no pass for 45 min, over 30 minutes, since ${iso(NOW - 45 * MINUTE)}; the pass under way started 40 min ago.`);
    });

    it("reads a heartbeat from a watcher older than lastProgressAt by its last pass and the one under way", async () => {
        const f = await fixture();
        const old = (extra: Partial<WatcherHeartbeat>) => beat(f, 30_000, 'committed', { lastProgressAt: undefined, ...extra });
        await old({ lastPassAt: iso(NOW - 10 * MINUTE) });
        expect((await status(f, { check: true })).exitCode).toBe(0);
        await old({ lastPassAt: iso(NOW - 31 * MINUTE) });
        expect((await status(f, { check: true })).output).toContain('  - The watcher has finished no pass for 31 min, over 30 minutes');
        await old({ lastPassAt: iso(NOW - 40 * MINUTE), lastPassResult: 'locked', passStartedAt: iso(NOW - 35 * MINUTE) });
        expect((await status(f, { check: true })).output).toContain('the pass under way started 35 min ago');
    });

    it('fails on a last pass that refused an empty library, even with no library-unavailable item to say so (A6 review)', async () => {
        const f = await fixture();
        await beat(f, 30_000, 'library-empty');
        const result = await status(f, { check: true });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("  - The watcher's last pass, at 2026-02-01T02:59:30.000Z, found the library empty while the registry has present photos, so it changed nothing.");
    });

    it("names no host path when the heartbeat can't be used, in the text or the JSON", async () => {
        const f = await fixture();
        fs.mkdirSync(path.dirname(watcherStatusFile(f.root)), { recursive: true });
        fs.writeFileSync(watcherStatusFile(f.root), '{"heartbeatAt": ');
        const text = await status(f, { check: true });
        expect(text.exitCode).toBe(1);
        const check = text.output.slice(text.output.indexOf('Check: failed.'));
        expect(check).toContain("  - The watcher's heartbeat, status/watcher.json, isn't valid JSON, so nothing shows it runs.");
        expect(check).not.toContain(f.root);
        const json = JSON.parse((await status(f, { check: true, json: true })).output) as { check: { problems: { code: string; message: string }[] } };
        expect(json.check.problems).toEqual([{ code: 'heartbeat-missing', message: "The watcher's heartbeat, status/watcher.json, isn't valid JSON, so nothing shows it runs" }]);
        expect(JSON.stringify(json.check)).not.toContain(f.root);
        fs.writeFileSync(watcherStatusFile(f.root), '{"heartbeatAt": 12}');
        expect((await status(f, { check: true })).output).toContain("  - The watcher's heartbeat, status/watcher.json, has no valid heartbeatAt, so nothing shows it runs.");
    });

    it('says a heartbeat stamped ahead of the clock is ahead, in plain status as --check does', async () => {
        const f = await fixture();
        await beat(f, -6 * MINUTE);
        const plain = await status(f);
        expect(plain.output).toContain(`Watcher heartbeat: stamped 6 min ahead of this clock (${iso(NOW + 6 * MINUTE)}), so it can't show the watcher runs`);
        expect(plain.output).not.toContain('Watcher heartbeat: 0 s ago');
        // A few seconds ahead, as two clocks drift, still reads as now.
        await beat(f, -9_000);
        expect((await status(f)).output).toContain(`Watcher heartbeat: 0 s ago (${iso(NOW + 9_000)})`);
    });
});
