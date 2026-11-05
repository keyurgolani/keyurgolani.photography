/**
 * #6's first-load guardrails, every number in one place. The Vitest budget
 * tests (`lib/perf/__tests__/budgets.test.ts`) hold each screen's read model
 * to SCREEN_BUDGETS on the 5,000-photo fixture (lib/perf/fixture.ts),
 * `photos validate` prints the same sizes for the candidate and warns when
 * one is over, and `npm run test:budgets` holds each screen's first load in
 * the browser to BROWSER_BUDGETS and FIRST_IMAGE_MS, writing every value
 * beside its budget to `.perf/report.json`. e2e/first-viewport.spec.ts reads
 * the request counts. A budget moves only in a PR that names the fixture,
 * the measurement command, and the numbers before and after, and the
 * approved change. Never delete one to get green.
 *
 * When a budget fails, apply these in order and stop once it passes: first
 * drop fields the screen doesn't render (`technical` and `caption` never
 * belong on Home or series list records), then drop variant `url`s from list
 * projections and have ResponsivePhoto rebuild them with mediaUrl() from
 * `id`, `assetRevision` and `profileId`, then drop `lqip` outside the first
 * viewport, and only then change the budget, as above.
 *
 * Catalog bytes are `gzipSync(JSON.stringify(model))` at zlib's default
 * level: the read model a server-rendered screen hands its client
 * components, compressed as a default server gzip would send it.
 *
 * Home ships the ordered ID list of every featured series, since v1.5.0
 * plays them all as one loop, at about 22 B gzip a photograph on the
 * fixture, plus the three records around the opening one. So Home's 50 KiB
 * holds about HOME_ID_LIST_PHOTOS (2,300) featured photographs in total,
 * across all featured series, whatever their number (limit 25). Past that,
 * `photos validate` warns.
 */

export const KIB = 1024;

export const SCREEN_BUDGETS = {
    /** `/`: #4's featured series. */
    home: {
        gzipBytes: 50 * KIB,
        /** Full-size derivatives requested eagerly on first load. #6's browser test checks it. */
        eagerFullSizeDerivatives: 2,
    },
    /** `/work`: #3's series summaries. */
    work: {
        gzipBytes: 100 * KIB,
        /** Photo sequences in the model. Each series ships its cover and nothing else from its photographs. */
        photoSequences: 0,
    },
    /** `/work/<slug>`: #5's title, statement, and first page of ordered photo records, whichever bound comes first. */
    seriesFirstPage: {
        gzipBytes: 100 * KIB,
        photoRecords: 100,
    },
    /**
     * `/api/catalog/series/<slug>/pages/<cursor>`: one page of #6's Show
     * more, 100 records. Tighter than the first page's 100 KiB on the owner's
     * "Yes, tighten them" (2026-11-04): the refined 60 KiB was for 48-record
     * pages, so this is 0.6 KiB a record. The fixture's largest page is about
     * 16 KiB. budgets.test.ts's long-copy stress page, 78.8 KiB of 1,000-character
     * descriptions, is a first page and stays on that page's 100 KiB.
     */
    seriesContinuationPage: {
        gzipBytes: 60 * KIB,
        photoRecords: 100,
    },
    /** `/work/<slug>/photo/<photoId>`: #7's one photograph with its neighbors as IDs. */
    viewer: {
        gzipBytes: 10 * KIB,
        photoRecords: 1,
    },
} as const;

export type Screen = keyof typeof SCREEN_BUDGETS;

/** The screens a browser opens: a continuation page is only ever fetched. */
export type BrowserScreen = Exclude<Screen, 'seriesContinuationPage'>;

/**
 * Featured photographs, across every featured series, that Home's 50 KiB
 * holds: limit 25, from the fixture's ID cost. budgets.test.ts checks the
 * fixture still reaches it, and `photos validate` prints the library's own.
 */
export const HOME_ID_LIST_PHOTOS = 2_300;

/** The browser's two profiles: a phone at 390×844 (DPR 3, touch) and a desktop at 1440×900 (DPR 2), from #6's refined table. */
export type BrowserProfile = 'phone' | 'desktop';

/**
 * #6's refined browser table, on today's basis: what each screen's first
 * load, from navigation to `load` and the network going quiet (5 s at
 * most), with no input, may transfer at each profile. `documentBytes` is
 * the HTML document as sent, compressed. `eagerImageBytes` adds up the
 * catalog images (`/media`) that load asks for, at the bytes the server
 * declares, and `otherImageBytes` every other image, About's portrait on
 * Home. Work's and a series' images are reported, not capped: the list rule
 * in e2e/first-viewport.spec.ts holds them. The refined table's Viewer ID
 * list is dropped: the Viewer ships one record and two neighbour IDs, held
 * to SCREEN_BUDGETS.viewer (owner, 2026-11-04).
 */
export const BROWSER_BUDGETS = {
    home: {
        documentBytes: 130 * KIB,
        eagerImageBytes: { phone: 750 * KIB, desktop: 750 * KIB },
        otherImageBytes: 150 * KIB,
    },
    work: { documentBytes: 230 * KIB },
    seriesFirstPage: { documentBytes: 230 * KIB },
    viewer: {
        documentBytes: 80 * KIB,
        eagerImageBytes: { phone: 400 * KIB, desktop: 750 * KIB },
    },
} as const satisfies Record<BrowserScreen, { documentBytes: number; eagerImageBytes?: Record<BrowserProfile, number>; otherImageBytes?: number }>;

/**
 * When the opening image on Home, a series, and the Viewer starts its
 * request, in ms after the document finished: `target` is reported, and a
 * start after `gate`, or no catalog image at all, fails.
 */
export const FIRST_IMAGE_MS = { target: 300, gate: 1_000 } as const;
