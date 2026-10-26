import type { BlockingError, Fix, Ledger, LedgerRow, Panel, ScreenModel } from './model';

/**
 * Fixture data for the 16-3 mockup, one model per state. Series, photographs
 * and copy are made up and provisional; the images are generated gradients
 * (public/mockup-publish/). Not for merge.
 */

const img = (name: string) => `/mockup-publish/${name}.jpg`;

const BREAKWATER = 'Breakwater, first light';
const BREAKWATER_ID = 'ph_7f3a…91c2';
const GENERATED_ALT = 'Six wooden posts stand in calm water at sunrise, the sun low and orange over a flat horizon.';

const descriptionFix = (open: boolean): Fix => ({
    type: 'description',
    record: BREAKWATER,
    photoId: BREAKWATER_ID,
    picture: { src: img('breakwater-first-light'), alt: 'Image, no description yet' },
    text: GENERATED_ALT,
    suggested: 'Suggested by the inbox (rules@1) on 25 October. Nobody has reviewed it.',
    open,
});

const orderFix: Fix = { type: 'restamp', record: 'Pier lamps position in Salt Roads', label: 'Still right, mark reviewed' };

function authored(stage: 'open' | 'fixing' | 'reviewed' | 'published'): LedgerRow[] {
    const done = stage === 'reviewed' || stage === 'published';
    const label = (review: LedgerRow['review']): LedgerRow['review'] => (stage === 'published' ? 'published' : review);
    return [
        {
            id: 'chg-new-breakwater',
            kind: 'New',
            review: label('reviewed'),
            summary: `Add ${BREAKWATER} to Low Tide Hours after photograph 04`,
            detail: 'Approved in the Inbox on 25 October. Series statement unchanged.',
        },
        {
            id: 'chg-alt-breakwater',
            kind: 'Changed',
            review: label(done ? 'reviewed' : 'generated'),
            summary: `Publish descriptive alternative text for ${BREAKWATER}`,
            detail: done ? 'Description reviewed and ready. Marked ready on this screen, just now.' : 'Required description is still a generated draft.',
            blocks: !done,
            compare: { type: 'text', before: null, after: GENERATED_ALT },
            ...(done ? {} : { fix: descriptionFix(stage === 'fixing') }),
        },
        {
            id: 'chg-short-low-tide',
            kind: 'Changed',
            review: label('reviewed'),
            summary: 'Low Tide Hours: the short statement changes',
            detail: 'Shows on Work. Edited with photos edit on 25 October.',
            compare: { type: 'text', before: 'Five mornings on the estuary before the water comes back.', after: 'Six mornings on the estuary before the water comes back.' },
        },
        {
            id: 'chg-move-pier',
            kind: 'Moved',
            review: label(done ? 'reviewed' : 'stale'),
            summary: 'Pier lamps moves from position 7 to 2 in Salt Roads',
            detail: done
                ? 'Marked reviewed on this screen, just now.'
                : 'Reviewed against revision 17. Revision 18 published the Salt Roads order differently, so check it still reads right.',
            blocks: !done,
            compare: { type: 'list', before: ['Coast road', 'Dune fence', 'Salt pans'], after: ['Coast road', 'Pier lamps', 'Dune fence'] },
            ...(done ? {} : { fix: orderFix }),
        },
        {
            id: 'chg-featured',
            kind: 'Changed',
            review: label('reviewed'),
            summary: 'Home features Salt Roads first',
            detail: 'Set with photos series featured on 24 October.',
            compare: { type: 'list', before: ['Low Tide Hours', 'Salt Roads'], after: ['Salt Roads', 'Low Tide Hours'] },
        },
    ];
}

function derived(published = false): LedgerRow[] {
    return [
        {
            id: 'chg-asset-harbor',
            kind: 'New image',
            review: published ? 'published' : 'confirmed',
            summary: 'Harbor wall gets a new image revision, b162…e49a',
            detail: 'In place of 7d0e…11a3. Confirmed in the Inbox on 24 October; its description was reviewed against the new image.',
            compare: {
                type: 'images',
                before: { src: img('harbor-wall-before'), alt: 'A dark sea wall runs into grey water under a pale overcast sky.' },
                after: { src: img('harbor-wall-after'), alt: 'A dark sea wall runs into grey water under a rose dusk sky.' },
            },
        },
        {
            id: 'chg-derived-low-tide',
            kind: 'Recalculated',
            review: published ? 'published' : 'automatic',
            summary: 'Low Tide Hours: 6 photographs, was 5',
            detail: 'Its dates now run March to October 2025. The two photographs after 04 shift by one.',
        },
        {
            id: 'chg-derived-breakwater',
            kind: 'Recalculated',
            review: published ? 'published' : 'automatic',
            summary: `${BREAKWATER}: size, image set and colour summary come from its file`,
            detail: '3 widths in AVIF and WebP, 1200 by 800.',
        },
        {
            id: 'chg-derived-harbor',
            kind: 'Recalculated',
            review: published ? 'published' : 'automatic',
            summary: 'Harbor wall: image set and colour summary come from the new file',
            detail: 'Follows the new image revision.',
        },
    ];
}

const health: LedgerRow[] = [
    {
        id: 'health-night-ferry',
        kind: 'Source health',
        review: 'automatic',
        summary: 'Night ferry: source missing; last published image kept',
        detail: 'Not a change. Visitors keep the published image. Its Inbox item says what to do.',
    },
];

const ledger = (stage: Parameters<typeof authored>[0]): Ledger => ({ authored: authored(stage), derived: derived(stage === 'published'), health: stage === 'published' ? [] : health });

const PANEL: Panel = {
    series: 'Low Tide Hours',
    count: '6 photographs, was 5',
    copyLine: 'The authored statement stays exactly as published. The short statement changes.',
    rollback: 'Last-known-good revision 18 remains rollback-ready.',
    src: '/mockup/publish/site',
};

const blockingErrors = (): BlockingError[] => [
    {
        rowId: 'chg-alt-breakwater',
        record: BREAKWATER,
        field: 'description',
        message: 'Required description is still a generated draft.',
        fix: descriptionFix(false),
    },
    {
        rowId: 'chg-move-pier',
        record: 'Salt Roads',
        field: 'order (Pier lamps)',
        message: 'Stale review: it was reviewed against revision 17, and revision 18 published the order differently.',
        fix: orderFix,
    },
];

const BASE = { draftNumber: 19, liveNumber: 18, draftHash: '3fa1c2d9', liveHash: '81b04e77', panel: PANEL } as const;
const UNLOCK = 'Publish unlocks after Validate revision passes.';

export const STATES: Record<string, { title: string; model: ScreenModel }> = {
    unvalidated: {
        title: 'Unvalidated: the ledger, Validate on, Publish waiting for it',
        model: { ...BASE, ledger: ledger('open'), validate: 'available', publish: 'unavailable', publishReason: UNLOCK },
    },
    blocked: {
        title: 'Blocked: Validate found two changes that need the curator',
        model: {
            ...BASE,
            ledger: ledger('open'),
            result: { type: 'blocked', lead: '2 changes need you before revision 19 can publish. Revision 18 stays live.', errors: blockingErrors() },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the changes above, then validate again.',
        },
    },
    fixing: {
        title: 'Fixing: Review and mark description ready, open under its row',
        model: {
            ...BASE,
            ledger: ledger('fixing'),
            result: { type: 'blocked', lead: '2 changes need you before revision 19 can publish. Revision 18 stays live.', errors: blockingErrors() },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the changes above, then validate again.',
        },
    },
    ready: {
        title: 'Ready: both fixed, validated, Publish on',
        model: { ...BASE, ledger: ledger('reviewed'), result: { type: 'valid' }, validate: 'available', publish: 'available' },
    },
    'confirm-alternative': {
        title: 'Alternative, only if wanted (owner question 1): an inline confirm after Publish',
        model: { ...BASE, ledger: ledger('reviewed'), result: { type: 'valid' }, validate: 'available', publish: 'available', confirm: true },
    },
    publishing: {
        title: 'Publishing: waiting on publish()',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            result: { type: 'valid' },
            validate: 'unavailable',
            publish: 'pending',
            status: 'Publishing revision 19. Revision 18 stays live until the switch.',
        },
    },
    published: {
        title: 'Published',
        model: {
            ...BASE,
            liveNumber: 19,
            liveHash: '3fa1c2d9',
            ledger: ledger('published'),
            ledgerHeading: 'Published in revision 19',
            result: { type: 'published', number: 19 },
            validate: 'hidden',
            publish: 'hidden',
            panel: { ...PANEL, count: '6 photographs', copyLine: 'Live now. The short statement shows on Work.', rollback: 'Last-known-good revision 19 remains rollback-ready.' },
        },
    },
    'blocked-at-publish': {
        title: 'Blocked at publish: a review went stale after Validate',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            notice: {
                tone: 'alert',
                heading: 'Nothing was published',
                body: '1 change went stale since you validated: Harbor wall has newer bytes waiting in the Inbox. Revision 18 stays live.',
            },
            result: {
                type: 'blocked',
                lead: '1 change needs you before revision 19 can publish. Revision 18 stays live.',
                errors: [
                    {
                        rowId: 'chg-asset-harbor',
                        record: 'Harbor wall',
                        field: 'image revision',
                        message: 'Stale review: its source changed again after the confirm, and the replacement waits in the Inbox.',
                        fix: { type: 'inbox', record: 'Harbor wall', eventId: 'evt_2c91…7a04' },
                    },
                ],
            },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the change above, then validate again.',
        },
    },
    'changed-meanwhile': {
        title: 'Changed meanwhile: the working catalog moved after the page loaded',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            notice: {
                tone: 'change',
                heading: 'The working catalog changed',
                body: 'It changed since this page loaded, so nothing was published. Review the updated ledger.',
                action: 'Load the updated ledger',
            },
            validate: 'unavailable',
            publish: 'unavailable',
            publishReason: 'Load the updated ledger first.',
        },
    },
    'someone-published': {
        title: 'Someone else published: the CLI published while the page was open',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            notice: {
                tone: 'change',
                heading: 'Revision 19 went live from the command line',
                body: 'keyur published it at 14:05 with photos publish. Nothing was published from here. The updated ledger compares against it.',
                action: 'Load the updated ledger',
            },
            validate: 'unavailable',
            publish: 'unavailable',
            publishReason: 'Load the updated ledger first.',
        },
    },
    'already-live': {
        title: 'Already live: this exact candidate is active (a retry, or someone published it)',
        model: {
            ...BASE,
            liveNumber: 19,
            liveHash: '3fa1c2d9',
            ledger: ledger('published'),
            ledgerHeading: 'Live in revision 19',
            notice: { tone: 'done', heading: 'Revision 19 is already live', body: 'It went live at 14:05, by curator:web. Nothing more to publish, and nothing new was written.' },
            validate: 'hidden',
            publish: 'hidden',
            panel: { ...PANEL, count: '6 photographs', copyLine: 'Live now.', rollback: 'Last-known-good revision 19 remains rollback-ready.' },
        },
    },
    busy: {
        title: 'Busy: another publish or rollback holds the catalog lock',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            result: { type: 'valid' },
            notice: {
                tone: 'change',
                heading: 'Another publish or rollback is running',
                body: 'photos publish, by keyur, since 14:02. Nothing changed. Try again when it finishes.',
                action: 'Try again',
            },
            validate: 'available',
            publish: 'available',
        },
    },
    failed: {
        title: 'Failed: publish() stopped on a storage error',
        model: {
            ...BASE,
            ledger: ledger('reviewed'),
            result: { type: 'valid' },
            notice: {
                tone: 'alert',
                heading: 'The publish stopped before revision 19 went live',
                body: 'Revision 18 is still live, and visitors see no change. The server log names what failed.',
                action: 'Try again',
            },
            validate: 'available',
            publish: 'available',
        },
    },
    'nothing-to-publish': {
        title: 'Nothing to publish: the working catalog is the live revision',
        model: {
            draftNumber: 18,
            liveNumber: 18,
            draftHash: '81b04e77',
            liveHash: '81b04e77',
            heading: 'Nothing to publish',
            lead: 'The working catalog matches revision 18, which is live. New photographs reach this screen once you approve them in the Inbox.',
            ledger: null,
            validate: 'hidden',
            publish: 'hidden',
            panel: { ...PANEL, count: '5 photographs', copyLine: 'What visitors see now.' },
        },
    },
    'no-visible-change': {
        title: 'No visible change: the draft differs only in hidden or draft series',
        model: {
            draftNumber: 19,
            liveNumber: 18,
            draftHash: '5d20e8a1',
            liveHash: '81b04e77',
            heading: 'Nothing to publish',
            lead: 'No visitor-visible changes. Edits to hidden or draft series stay saved and publish when the series becomes visible.',
            ledger: null,
            validate: 'hidden',
            publish: 'hidden',
            panel: { ...PANEL, count: '5 photographs', copyLine: 'What visitors see now.' },
        },
    },
    'not-launched': {
        title: 'Not launched: nothing is active yet',
        model: {
            draftNumber: 1,
            liveNumber: null,
            draftHash: '3fa1c2d9',
            liveHash: null,
            ledger: null,
            validate: 'hidden',
            publish: 'hidden',
            panel: null,
            page: {
                heading: 'Nothing is live yet',
                body: 'The first publish replaces the legacy Home and Gallery, and it runs from the command line, where it prints what changes and asks you to confirm the launch.',
                code: 'photos publish --confirm-launch',
                action: 'Check again',
            },
        },
    },
    unreadable: {
        title: 'Unreadable: the catalog or the data root can’t be read',
        model: {
            draftNumber: 0,
            liveNumber: null,
            draftHash: '',
            liveHash: null,
            ledger: null,
            validate: 'hidden',
            publish: 'hidden',
            panel: null,
            page: {
                heading: 'The catalog can’t be read right now',
                body: 'Something in the data root couldn’t be read, so nothing is shown and nothing was written. The server log names what failed.',
                action: 'Try again',
            },
        },
    },
};

export const STATE_ORDER = Object.keys(STATES);
