import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LedgerRow, PublishState, ScreenView } from '@/lib/curation/publish-facts';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import { BREAKWATER_TITLE, createPublishFixture, type PublishFixture } from '@/test/helpers/publishFixture';
import { disabledSet, gateMarks, serverHtml, watchGate } from '@/test/helpers/submitGateForms';

// The Publish screen's forms at the submit gate (components/site/submitGateScript.ts): the description review, Still
// right, Use the published value, and the bar's Validate and Publish. Each posts through the screen's action, so the
// head's script drops a press on it until it has mounted. In the server HTML each waits; once mounted each is ready;
// a fix the client opens is ready from its first render; and nothing is disabled for the gate, so with no JavaScript,
// where nothing gates, the server's markup is all there is. Test values only.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

let fixture: PublishFixture;
let restore: () => void;
let view: ScreenView;
let descriptionRow: LedgerRow;

beforeAll(async () => {
    fixture = await createPublishFixture();
    restore = setDataDir(fixture.root);
    const { loadPublishPage } = await import('../load');
    const page = await loadPublishPage();
    if (page.state !== 'ready') throw new Error(`The page is ${page.state}`);
    view = page.view;
    const row = [...view.ledger.authored, ...view.ledger.derived].find((entry) => entry.fix?.type === 'description');
    if (!row) throw new Error('No description row');
    descriptionRow = row;
}, 60_000);

afterAll(async () => {
    restore();
    await fixture.cleanup();
});

const action = async (previous: PublishState) => previous;

/** The four forms, by the first submit each holds: the fix the URL opened, the two stamps, and the bar. */
const FORMS = [
    'the form of Still right, mark reviewed: Pier lamps position in Salt Roads',
    "the form of Use the published value: the order of Salt Roads, from Pier lamps' move",
    `the form of Mark description ready: ${BREAKWATER_TITLE}`,
    'the form of Validate revision',
];

describe("the Publish screen's forms at the submit gate", () => {
    it('wait at the gate in the server HTML, every one of them, with nothing disabled for it', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const screenFor = () => <PublishScreen view={view} previewHref="/curation/preview/x" openFix={descriptionRow.id} action={action} />;
        const html = serverHtml(screenFor());
        expect(gateMarks(html).map(([name]) => name).sort()).toEqual([...FORMS].sort());
        for (const [name, mark] of gateMarks(html)) expect(mark, name).toBe('waiting');
        // Without JavaScript nothing gates, so nothing is disabled for want of it: the server's disabled set is the mounted page's.
        const { container, unmount } = render(screenFor());
        expect(disabledSet(html)).toEqual(disabledSet(container));
        unmount();
    });

    it('say they are ready once mounted, each one', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={descriptionRow.id} action={action} />);
        expect(gateMarks(container).map(([name]) => name).sort()).toEqual([...FORMS].sort());
        for (const [name, mark] of gateMarks(container)) expect(mark, name).toBe('ready');
    });

    it('take a press at once in the description review the client opens, which never waits at the gate', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        // jsdom has no scrollIntoView(), which the opened fix's heading is brought into view with, so this stands in.
        const prototype = Element.prototype as unknown as Record<string, unknown>;
        prototype.scrollIntoView = () => undefined;
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const watch = watchGate(container);
        await act(async () => {
            fireEvent.click(screen.getByRole('link', { name: new RegExp(`^Review and mark description ready\\s*: ${BREAKWATER_TITLE}$`) }));
        });
        const form = screen.getByRole('button', { name: new RegExp(`^Mark description ready\\s*: ${BREAKWATER_TITLE}$`) }).closest('form');
        expect(form).toHaveAttribute('data-submit-gate', 'ready');
        watch.stop();
        expect(watch.flips()).toEqual([]);
        delete prototype.scrollIntoView;
    });
});
