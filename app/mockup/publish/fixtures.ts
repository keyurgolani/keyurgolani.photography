import type { BlockingError, Fix, Ledger, LedgerRow, Panel, Refusal, ScreenModel } from './model';

/**
 * Fixture data for the 16-3 mockup, one model per state. Series, photographs
 * and copy are made up and provisional; the images are generated gradients
 * (public/mockup-publish/). Not for merge.
 *
 * New states go at the end of STATES, so the shot numbers of round 1 keep
 * their names.
 */

const img = (name: string) => `/mockup-publish/${name}.jpg`;

/** The Inbox's own `itemUrl()` (app/curation/inbox/journey.ts), so a phone lands on the item. */
export const itemUrl = (id: string) => `/curation/inbox?item=${id}#item`;

const BREAKWATER = 'Breakwater, first light';
export const BREAKWATER_ID = 'ph_7f3a2b8c4d5e6f7a8b9c0d1e2f3a91c2';
const BREAKWATER_ITEM = 'evt_5b18e0c4a7d24f3b9e61c0a8d2f47b35';
const HARBOR_EVENT = 'evt_2c91d4e8b07a4c5f8e3b6a1d9f0c7a04';
const GENERATED_ALT = 'Six wooden posts stand in calm water at sunrise, the sun low and orange over a flat horizon.';

const REFUSAL: Refusal = { text: 'This changed since the page loaded, so nothing was written.', action: 'Load the updated ledger' };

const descriptionFix = (open: boolean, refused = false): Fix => ({
    type: 'description',
    record: BREAKWATER,
    photoId: BREAKWATER_ID,
    inboxItem: BREAKWATER_ITEM,
    picture: { src: img('breakwater-first-light'), alt: 'Image, no description yet' },
    text: GENERATED_ALT,
    suggested: 'Suggested by the Inbox on 25 October. Nobody has reviewed it.',
    open,
    ...(refused ? { refusal: REFUSAL } : {}),
});

const orderFix: Fix = { type: 'restamp', record: 'Pier lamps position in Salt Roads', label: 'Still right, mark reviewed' };

/** Salt Roads, eight photographs: Pier lamps moves from 7 to 2. */
const SALT_ROADS_PUBLISHED = ['Coast road', 'Dune fence', 'Salt pans', 'Tide gauge', 'Net sheds', 'Slipway', 'Pier lamps', 'Ferry steps'];
const SALT_ROADS_DRAFT = ['Coast road', 'Pier lamps', 'Dune fence', 'Salt pans', 'Tide gauge', 'Net sheds', 'Slipway', 'Ferry steps'];

type Stage = 'open' | 'fixing' | 'refused' | 'reviewed' | 'published';

function authored(stage: Stage): LedgerRow[] {
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
            detail: done ? 'Description reviewed and ready. Marked ready from this screen, just now.' : 'Required description is still a generated draft.',
            blocks: !done,
            compare: { type: 'text', before: null, after: GENERATED_ALT },
            ...(done ? {} : { fix: descriptionFix(stage === 'fixing' || stage === 'refused', stage === 'refused') }),
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
                ? 'Marked reviewed from this screen, just now.'
                : 'Reviewed against revision 17. Revision 18 published the Salt Roads order differently, so check it still reads right.',
            blocks: !done,
            compare: { type: 'list', before: SALT_ROADS_PUBLISHED, after: SALT_ROADS_DRAFT, moved: 'Pier lamps', from: 7, to: 2 },
            ...(done ? {} : { fix: orderFix }),
        },
        {
            id: 'chg-featured',
            kind: 'Changed',
            review: label('reviewed'),
            summary: 'Home features Salt Roads first',
            detail: 'Set with photos series featured on 24 October.',
            compare: { type: 'list', before: ['Low Tide Hours', 'Salt Roads'], after: ['Salt Roads', 'Low Tide Hours'], moved: 'Salt Roads', from: 2, to: 1 },
        },
    ];
}

/** `harbor`: 'confirmed' as validated, 'stale' once its source changed again (blocked at publish), 'published' when live. */
function derived(harbor: 'confirmed' | 'stale' | 'published'): LedgerRow[] {
    const published = harbor === 'published';
    const stale = harbor === 'stale';
    return [
        {
            id: 'chg-asset-harbor',
            kind: 'New image',
            review: stale ? 'stale' : published ? 'published' : 'confirmed',
            summary: 'Harbor wall gets a new image revision, b162…e49a',
            detail: stale
                ? 'In place of 7d0e…11a3. Its source changed again after the confirm on 24 October, and the replacement waits in the Inbox.'
                : 'In place of 7d0e…11a3. Confirmed in the Inbox on 24 October; its description was reviewed against the new image.',
            ...(stale ? { blocks: true, fix: { type: 'inbox', record: 'Harbor wall', eventId: HARBOR_EVENT } as Fix } : {}),
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

// Source health stays in the live states too, since it is still true.
const health: LedgerRow[] = [
    {
        id: 'health-night-ferry',
        kind: 'Source health',
        review: 'automatic',
        summary: 'Night ferry: source missing; last published image kept',
        detail: 'Not a change. Visitors keep the published image. Its Inbox item says what to do.',
    },
];

const ledger = (stage: Stage, harbor: Parameters<typeof derived>[0] = stage === 'published' ? 'published' : 'confirmed'): Ledger => ({
    authored: authored(stage),
    derived: derived(harbor),
    health,
});

const FRAME_SRC = `/mockup/publish/site#photo-${BREAKWATER_ID}`;

const DRAFT_PANEL: Panel = {
    title: 'Visitor preview',
    link: { label: 'Open full preview', href: '/mockup/publish/site' },
    marker: 'Preview · not public',
    frameTitle: 'Visitor preview of the draft catalog',
    count: 'Low Tide Hours: 6 photographs, was 5',
    copyLine: 'The authored statement stays exactly as published. The short statement changes.',
    rollback: 'Last-known-good revision 18 remains rollback-ready.',
    src: FRAME_SRC,
};

const LIVE_PANEL: Panel = {
    title: 'Live site',
    link: null,
    marker: 'Live, revision 19',
    frameTitle: 'The live site, revision 19',
    count: 'Low Tide Hours: 6 photographs',
    copyLine: 'Live now. The short statement shows on Work.',
    rollback: 'Revision 18 is kept. `photos rollback` returns to it.',
    src: FRAME_SRC,
};

const outOfDatePanel = (rollback: string): Panel => ({
    ...DRAFT_PANEL,
    link: null,
    frameNote: 'Load the updated ledger to preview the new draft.',
    rollback,
});

const NOTHING_PANEL: Panel = {
    title: 'Live site',
    link: { label: 'Open the site', href: '/mockup/publish/site' },
    marker: 'Live, revision 18',
    frameTitle: 'The live site, revision 18',
    count: 'Low Tide Hours: 5 photographs',
    copyLine: 'What visitors see now.',
    rollback: 'Revision 17 is kept. `photos rollback` returns to it.',
    src: '/mockup/publish/site',
};

const blockingErrors = (): BlockingError[] => [
    {
        rowId: 'chg-alt-breakwater',
        record: BREAKWATER,
        field: 'description',
        message: 'Required description is still a generated draft.',
        link: { type: 'description', name: BREAKWATER },
    },
    {
        rowId: 'chg-move-pier',
        record: 'Salt Roads',
        field: 'order (Pier lamps)',
        message: 'Stale review: it was reviewed against revision 17, and revision 18 published the order differently.',
        link: { type: 'restamp', name: 'Salt Roads order' },
    },
];

const COUNT = '9 changes for visitors: 5 authored, 4 derived.';
const COUNT_TWO = `${COUNT} 2 block publishing.`;

/** Draft pending: Unvalidated to Failed. */
const DRAFT = {
    draftNumber: 19,
    heading: 'Preview catalog revision 19',
    lead: 'Authored changes require approval. Derived facts refresh from the validated catalog.',
    countLine: COUNT,
    revision: { current: 'Current public revision 18', hashes: 'Draft 3fa1c2d9 · Live 81b04e77' },
    ledgerHeading: 'Change ledger',
    groups: 'draft',
    compareLabels: { before: 'Published', after: 'This draft' },
    panel: DRAFT_PANEL,
} as const satisfies Partial<ScreenModel>;

/** Live: Published, Already live, Failed with the pointer moved. */
const LIVE = {
    draftNumber: 19,
    heading: 'Revision 19 is live',
    countLine: '9 changes went live: 5 authored, 4 derived.',
    revision: { current: 'Current public revision 19', hashes: 'Live 3fa1c2d9' },
    groups: 'live',
    compareLabels: { before: 'Before', after: 'Now live' },
    panel: LIVE_PANEL,
} as const satisfies Partial<ScreenModel>;

/** Out of date: Changed meanwhile, Someone else published. The bar is hidden; the result's Load the updated ledger is the one action. */
const OUT_OF_DATE = {
    draftNumber: 19,
    heading: 'Preview your draft',
    countLine: 'Out of date. Load the updated ledger to see what publishes now.',
    ledgerHeading: 'Change ledger, out of date',
    outOfDate: 'This compares the draft this page loaded against revision 18.',
    groups: 'draft',
    compareLabels: { before: 'Published', after: 'This draft' },
    validate: 'hidden',
    publish: 'hidden',
} as const satisfies Partial<ScreenModel>;

/** Nothing: Nothing to publish, No visible change. */
const NOTHING = {
    draftNumber: 18,
    heading: 'Nothing to publish',
    revision: { current: 'Current public revision 18', hashes: 'Live 81b04e77' },
    ledger: null,
    ledgerHeading: '',
    groups: 'live',
    compareLabels: { before: 'Before', after: 'Now live' },
    validate: 'hidden',
    publish: 'hidden',
    panel: NOTHING_PANEL,
    inboxLink: true,
} as const satisfies Partial<ScreenModel>;

const WHOLE_PAGE = {
    draftNumber: 0,
    heading: '',
    revision: null,
    ledger: null,
    ledgerHeading: '',
    groups: 'draft',
    compareLabels: { before: 'Published', after: 'This draft' },
    validate: 'hidden',
    publish: 'hidden',
    panel: null,
} as const satisfies Partial<ScreenModel>;

const UNLOCK = 'Publish unlocks after Validate revision passes.';
const BLOCKED_LEAD = '2 changes need you before revision 19 can publish. Revision 18 stays live.';
const STAKES = 'Publishing makes these 9 changes live on every page. Revision 18 stays rollback-ready.';

export const STATES: Record<string, { title: string; model: ScreenModel }> = {
    unvalidated: {
        title: 'Unvalidated: the ledger, Validate on, Publish waiting for it',
        model: { ...DRAFT, countLine: COUNT_TWO, ledger: ledger('open'), validate: 'available', publish: 'unavailable', publishReason: '2 changes block publishing. Fix them, then validate.' },
    },
    blocked: {
        title: 'Blocked: Validate found two changes that need the curator',
        model: {
            ...DRAFT,
            countLine: COUNT_TWO,
            ledger: ledger('open'),
            result: { type: 'blocked', lead: BLOCKED_LEAD, errors: blockingErrors() },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the changes above, then validate again.',
        },
    },
    fixing: {
        title: 'Fixing: Review and mark description ready, open under its row',
        model: {
            ...DRAFT,
            countLine: COUNT_TWO,
            ledger: ledger('fixing'),
            result: { type: 'blocked', lead: BLOCKED_LEAD, errors: blockingErrors() },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the changes above, then validate again.',
        },
    },
    ready: {
        title: 'Ready: both fixed, validated, Publish on',
        model: { ...DRAFT, ledger: ledger('reviewed'), result: { type: 'valid', stakes: STAKES }, validate: 'available', publish: 'available' },
    },
    'confirm-alternative': {
        title: 'Alternative, only if wanted (owner question 1): an inline confirm after Publish',
        model: { ...DRAFT, ledger: ledger('reviewed'), result: { type: 'valid', stakes: STAKES }, validate: 'available', publish: 'available', confirm: true },
    },
    publishing: {
        title: 'Publishing: waiting on publish()',
        model: {
            ...DRAFT,
            ledger: ledger('reviewed'),
            result: { type: 'valid', stakes: STAKES },
            validate: 'unavailable',
            publish: 'pending',
            publishReason: 'Revision 18 stays live until the switch.',
            status: 'Publishing revision 19. Revision 18 stays live until the switch.',
        },
    },
    published: {
        title: 'Published',
        model: {
            ...LIVE,
            ledger: ledger('published'),
            ledgerHeading: 'Published in revision 19',
            result: { type: 'published', number: 19 },
            validate: 'hidden',
            publish: 'hidden',
            status: 'Revision 19 published.',
        },
    },
    'blocked-at-publish': {
        title: 'Blocked at publish: a review went stale after Validate',
        model: {
            ...DRAFT,
            countLine: `${COUNT} 1 blocks publishing.`,
            ledger: ledger('reviewed', 'stale'),
            result: {
                type: 'blocked-at-publish',
                lead: '1 change went stale since you validated. Revision 18 stays live.',
                errors: [
                    {
                        rowId: 'chg-asset-harbor',
                        record: 'Harbor wall',
                        field: 'image revision',
                        message: 'Stale review: its source changed again after the confirm, and the replacement waits in the Inbox.',
                        link: { type: 'inbox', record: 'Harbor wall', eventId: HARBOR_EVENT },
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
            ...OUT_OF_DATE,
            revision: { current: 'Current public revision 18', hashes: 'Live 81b04e77' },
            ledger: ledger('reviewed'),
            result: { type: 'changed', body: 'It changed after this page loaded, so nothing was published. Revision 18 stays live.' },
            panel: outOfDatePanel('Last-known-good revision 18 remains rollback-ready.'),
        },
    },
    'someone-published': {
        title: 'Someone else published: the CLI published while the page was open',
        model: {
            ...OUT_OF_DATE,
            revision: { current: 'Current public revision 19', hashes: 'Live 5d20e8a1' },
            ledger: ledger('reviewed'),
            result: { type: 'someone-published', number: 19, by: 'keyur published it at 14:05, with photos publish.' },
            panel: outOfDatePanel('Revision 18 is kept. `photos rollback` returns to it.'),
        },
    },
    'already-live': {
        title: 'Already live: this exact candidate is active (a retry, or someone published it)',
        model: {
            ...LIVE,
            ledger: ledger('published'),
            ledgerHeading: 'Live in revision 19',
            result: { type: 'already-live', number: 19, by: 'It went live from this screen at 14:05.' },
            validate: 'hidden',
            publish: 'hidden',
        },
    },
    busy: {
        title: 'Busy: another publish or rollback holds the catalog lock',
        model: {
            ...DRAFT,
            ledger: ledger('reviewed'),
            result: { type: 'busy', body: 'keyur is running photos publish, since 14:02. Nothing changed here. Publish again when it finishes.' },
            validate: 'available',
            publish: 'available',
        },
    },
    failed: {
        title: 'Failed: publish() stopped on a storage error',
        model: {
            ...DRAFT,
            ledger: ledger('reviewed'),
            result: {
                type: 'failed',
                heading: 'The publish stopped before revision 19 went live',
                body: 'Revision 18 is still live, and visitors see no change. The server log names what failed. Publish again to retry.',
            },
            validate: 'available',
            publish: 'available',
        },
    },
    'nothing-to-publish': {
        title: 'Nothing to publish: the working catalog is the live revision',
        model: {
            ...NOTHING,
            lead: 'The working catalog matches revision 18, which is live. New photographs reach this screen once you approve them in the Inbox.',
        },
    },
    'no-visible-change': {
        title: 'No visible change: the draft differs only in hidden or draft series',
        model: {
            ...NOTHING,
            lead: 'No visitor-visible changes. Edits to hidden or draft series stay saved and publish when the series becomes visible.',
        },
    },
    'not-launched': {
        title: 'Not launched: nothing is active yet',
        model: {
            ...WHOLE_PAGE,
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
            ...WHOLE_PAGE,
            page: {
                heading: 'The catalog can’t be read right now',
                body: 'Something in the data root couldn’t be read, so nothing is shown and nothing was written. The server log names what failed.',
                action: 'Try again',
            },
        },
    },
    // Round 2 states, appended so round 1's numbers keep their names.
    validating: {
        title: 'Validating: Validate pressed after the fixes, waiting',
        model: {
            ...DRAFT,
            ledger: ledger('reviewed'),
            validate: 'pending',
            publish: 'unavailable',
            publishReason: UNLOCK,
            status: 'Checking revision 19.',
        },
    },
    'fix-refused': {
        title: 'Fix refused: the description moved after the page loaded, so nothing was written',
        model: {
            ...DRAFT,
            countLine: COUNT_TWO,
            ledger: ledger('refused'),
            result: { type: 'blocked', lead: BLOCKED_LEAD, errors: blockingErrors() },
            validate: 'available',
            publish: 'unavailable',
            publishReason: 'Fix the changes above, then validate again.',
        },
    },
    'failed-moved': {
        title: 'Failed with the pointer moved: revision 19 is live, but the publish didn’t finish',
        model: {
            ...LIVE,
            ledger: ledger('published'),
            ledgerHeading: 'Live in revision 19',
            result: { type: 'failed', heading: 'Revision 19 is live, but the publish didn’t finish', body: 'The server log names what failed. Publish again to finish it.' },
            validate: 'hidden',
            publish: 'available',
        },
    },
};

export const STATE_ORDER = Object.keys(STATES);
