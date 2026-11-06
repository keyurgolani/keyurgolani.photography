import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readAuthoredRecord } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { IDLE_STATE, type LedgerRow, type PublishState, type ScreenView, type WatchAnswer } from '@/lib/curation/publish-facts';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import { BREAKWATER_TITLE, createPublishFixture, fixBoth, publishFromCli, SALT_ROADS, type PublishFixture } from '@/test/helpers/publishFixture';

// A9's review fixes (prs/A9-review-fixes.md) on the client screen, from real
// page reads: a collapsed group opens for the description review, every
// control's name is its own when one series has two moves and two chapter
// changes, the watch's line isn't said again after a press, focus survives
// Base moved, and a collapsed group's summary says its state. Test values only.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

let fixture: PublishFixture;
let busy: PublishFixture;
let view: ScreenView;
let busyView: ScreenView;

async function load(root: string): Promise<ScreenView> {
    const undo = setDataDir(root);
    try {
        const { loadPublishPage } = await import('../load');
        const page = await loadPublishPage();
        if (page.state !== 'ready') throw new Error(`The page is ${page.state}`);
        return page.view;
    } finally {
        undo();
    }
}

/**
 * The fixture with revision 3 publishing Salt Roads with two chapters, then a
 * draft reviewed against revision 2 that moves two more photographs and
 * changes both chapters: every one of those rows is stale against revision 3,
 * so each carries Still right, mark reviewed and Use the published value.
 */
async function twoMovesTwoChapters(): Promise<PublishFixture> {
    const made = await createPublishFixture();
    await fixBoth(made);
    const series = await readAuthoredRecord(made.root, 'series', SALT_ROADS);
    if (series?.kind !== 'series') throw new Error('No Salt Roads');
    const order = series.photoIds;
    await writeAuthoredRecord({ ...series, chapters: [{ id: 'ch-dawn', title: 'Dawn', startPhotoId: order[0] }, { id: 'ch-dusk', title: 'Dusk', startPhotoId: order[3] }] }, { expectedVersion: series.version, root: made.root });
    await publishFromCli(made);
    const live = await readAuthoredRecord(made.root, 'series', SALT_ROADS);
    if (live?.kind !== 'series') throw new Error('No Salt Roads');
    const moved = [live.photoIds[7], live.photoIds[6], ...live.photoIds.slice(0, 6)];
    await writeAuthoredRecord(
        { ...live, photoIds: moved, chapters: [{ id: 'ch-dawn', title: 'First light', startPhotoId: live.photoIds[0] }, { id: 'ch-dusk', title: 'Dusk', startPhotoId: live.photoIds[5] }] },
        { expectedVersion: live.version, root: made.root, review: { baseRevisionId: made.revisions[1], origin: 'curator', actor: 'keyur', reviewedAt: new Date().toISOString() } },
    );
    return made;
}

beforeAll(async () => {
    fixture = await createPublishFixture();
    view = await load(fixture.root);
    busy = await twoMovesTwoChapters();
    busyView = await load(busy.root);
}, 120_000);

afterAll(async () => {
    await fixture.cleanup();
    await busy.cleanup();
});

const action = async (previous: PublishState) => previous;
const rowsOf = (screenView: ScreenView): LedgerRow[] => [...screenView.ledger.authored, ...screenView.ledger.derived, ...screenView.ledger.health];

/** The page with its authored group padded past 50 rows by copies of a reviewed row. */
function padded(screenView: ScreenView): ScreenView {
    const reviewed = screenView.ledger.authored.find((row) => !row.blocks) as LedgerRow;
    const copies = Array.from({ length: 50 }, (_, index) => ({ ...reviewed, id: `chg-${(0xa000 + index).toString(16).padStart(16, '0')}`, summary: `Padding row ${index}` }));
    return { ...screenView, ledger: { ...screenView.ledger, authored: [...screenView.ledger.authored, ...copies] } };
}

describe('the review fixes on the screen', () => {
    it('opens a collapsed group for "Review and mark description ready", so focus lands on the open fix (blocker 1)', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={padded(view)} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const details = container.querySelector('section[data-group="authored"] details') as HTMLDetailsElement;
        expect(details.open).toBe(false);
        // jsdom lays nothing out.
        Element.prototype.scrollIntoView = () => undefined;
        await act(async () => {
            fireEvent.click(screen.getByRole('link', { name: new RegExp(`^Review and mark description ready\\s*: ${BREAKWATER_TITLE}$`) }));
        });
        expect(details.open).toBe(true);
        expect(document.activeElement?.id).toBe('fix-heading');
    });

    it('renders the group open when the URL opens a fix inside it, for a page without JavaScript (blocker 1)', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const row = view.ledger.authored.find((entry) => entry.fix?.type === 'description') as LedgerRow;
        const { container } = render(<PublishScreen view={padded(view)} previewHref="/curation/preview/x" openFix={row.id} action={action} />);
        expect((container.querySelector('section[data-group="authored"] details') as HTMLDetailsElement).open).toBe(true);
    });

    it('gives every control its own name with two moves and two chapter changes in one series (should-fix 2)', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const blocking = rowsOf(busyView).filter((row) => row.blocks);
        expect(blocking.filter((row) => row.usePublished).length).toBeGreaterThanOrEqual(4);
        const { container } = render(<PublishScreen view={busyView} previewHref="/curation/preview/x" openFix={null} action={action} />);
        // Testing Library's own name computation, the one getByRole uses, collected through its name filter.
        const names: string[] = [];
        for (const role of ['button', 'link'] as const) {
            within(container).queryAllByRole(role, {
                name: (name) => {
                    names.push(name);
                    return true;
                },
            });
        }
        expect(names.length).toBeGreaterThan(8);
        const counts = new Map<string, number>();
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
        expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
        expect(names.filter((name) => name === '')).toEqual([]);
    });

    it("clears the watch's line when a press starts, so the region doesn't say it again after the answer (should-fix 3)", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { default: PublishScreen } = await import('../PublishScreen');
            const reviewed = view.ledger.authored.find((row) => row.review === 'reviewed') as LedgerRow;
            const watch = async (): Promise<WatchAnswer> => ({ kind: 'ok', stale: [{ rowId: reviewed.id, summary: reviewed.summary }], draftChanged: false });
            let release: (state: PublishState) => void = () => undefined;
            const slow = (previous: PublishState) => new Promise<PublishState>((resolve) => (release = () => resolve(previous)));
            const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={slow} watch={watch} />);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            const region = container.querySelector('[role="status"]') as HTMLElement;
            expect(region).toHaveTextContent(/went stale after this page loaded/);
            await act(async () => {
                fireEvent.click(container.querySelector('button[value="validate"]') as HTMLButtonElement);
            });
            expect(region).toHaveTextContent('Checking revision 3.');
            await act(async () => {
                release(IDLE_STATE);
            });
            expect(region).toHaveTextContent('');
        } finally {
            vi.useRealTimers();
        }
    });

    it('moves focus to Load the updated ledger when Base moved takes the focused button away (should-fix 4)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { default: PublishScreen } = await import('../PublishScreen');
            const live = { revisionId: `rev_${'c'.repeat(64)}`, number: 3, hash: 'cccccccc' };
            const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} watch={async () => ({ kind: 'base-moved', live })} />);
            (container.querySelector('button[value="validate"]') as HTMLButtonElement).focus();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Load the updated ledger' }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('says whether a collapsed group is open, with Hide once it is (nit)', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={padded(view)} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const details = container.querySelector('section[data-group="authored"] details') as HTMLDetailsElement;
        const n = padded(view).ledger.authored.length;
        expect(details.querySelector('summary')).toHaveTextContent(`Show all ${n} changes in this group`);
        await act(async () => {
            details.open = true;
            fireEvent(details, new Event('toggle'));
        });
        expect(details.querySelector('summary')).toHaveTextContent(`Hide the ${n} changes in this group`);
        expect(details.querySelector('summary svg')).not.toBeNull();
    });
});
