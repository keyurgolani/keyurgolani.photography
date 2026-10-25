/**
 * #6's first-load guardrails, every number in one place. The Vitest budget
 * tests (`lib/perf/__tests__/budgets.test.ts`) hold each screen's read model
 * to these on the 5,000-photo fixture, and #6's browser test reads the same
 * module for request counts. A budget moves only in a PR that names the
 * fixture, the measurement command, and the numbers before and after, and
 * the approved change. Never delete one to get green.
 *
 * Catalog bytes are `gzipSync(JSON.stringify(model))` at zlib's default
 * level: the read model a server-rendered screen hands its client
 * components, compressed as a default server gzip would send it.
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
    /** `/work/<slug>/photo/<photoId>`: #7's one photograph with its neighbors as IDs. */
    viewer: {
        gzipBytes: 10 * KIB,
        photoRecords: 1,
    },
} as const;

export type Screen = keyof typeof SCREEN_BUDGETS;
