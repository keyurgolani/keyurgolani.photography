// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { runStatusCommand } from '../../catalog/owner-status';
import { writeWatcherHeartbeat, type PassResult } from '../../identity/heartbeat';
import type { IdentityFact } from '../../identity/types';
import { eventIdOf, eventKey, type CurationEventType } from '../events';
import { readEvent, withCurationLock, writeEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, type CurationFixture } from './curationFixtures';

/**
 * #14 and #17 (v2.0.0, A2): `photos status` counts what needs review and
 * what is open, and `--check` is the monitor's exit code on today's event
 * types: 1 on an open missing, failed, or ambiguous item, on a failed last
 * pass, or on a heartbeat over 5 minutes old, and 0 otherwise.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
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

/** The watcher's heartbeat, `ageMs` before NOW, with its last pass's result. */
const beat = (f: CurationFixture, ageMs: number, lastPassResult: PassResult | null = 'committed') =>
    writeWatcherHeartbeat(f.root, { pid: 1, hostname: 'fixture', lastPassAt: lastPassResult === null ? null : iso(NOW - ageMs), lastPassResult, passStartedAt: null, heartbeatAt: iso(NOW - ageMs), legacyDerivatives: false });

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
        expect(json.inbox.counts).toEqual({ needsReview: 4, missing: 1, failed: 1, ambiguous: 1, stale: 0 });
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
