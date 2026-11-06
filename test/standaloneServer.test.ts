// @vitest-environment node
/**
 * The pure parts of test/helpers/standaloneServer.ts, which the production
 * rows (test/prod/pageFreshness.test.ts, test/prod/publishBurst.test.ts)
 * read every page through: the HTML readers, the error-shell skeleton, and
 * C1's window rule. These run in the unit suite, with no build or server.
 */
import { describe, expect, it } from 'vitest';
import { WORK_ERROR_BODY } from './fixtures/errorShell';
import { blockingText, bodyOf, errorShellProblems, headOf, markers, meta, servableRevisions, skeleton, srcsetCandidates, viewerMarkup, type PublishTimes } from './helpers/standaloneServer';

const A = `rev_${'a'.repeat(64)}`;
const B = `rev_${'b'.repeat(64)}`;

/** A series page as React and Next send it: the tags, then the Flight payload, whose JSON names the same props. */
const SERIES = [
    '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>',
    // The theme script compares, so a `<` inside a script must not open a tag.
    '<script>if(a<b){document.documentElement.dataset.x="<main data-catalog-revision=\\"' + B + '\\">"}</script>',
    '<title>Harbor · Keyur Golani Photography</title>',
    '<meta name="description" content="Fish &amp; chips."/>',
    `<meta name="catalog-revision" content="${A}"/>`,
    '<link rel="canonical" href="https://example.test/work/harbor"/>',
    '<meta property="og:image" content="https://example.test/media/x/w1200.webp"/>',
    '</head><body class="font-sans">',
    `<main class="page" data-catalog-revision="${A}"><h1 id="series-title">Harbor</h1><p>A statement.</p></main>`,
    `<script>self.__next_f.push([1,"[\\"$\\",\\"main\\",null,{\\"data-catalog-revision\\":\\"${A}\\"}]"])</script>`,
    '</body></html>',
].join('');

describe('the HTML readers', () => {
    it('splits the document at </head>', () => {
        expect(headOf(SERIES)).toContain('<title>Harbor');
        expect(headOf(SERIES)).not.toContain('<h1');
        expect(bodyOf(SERIES)).toContain('<main');
        expect(bodyOf(SERIES)).not.toContain('<title>');
        // No head at all: everything is body.
        expect(headOf('<p>x</p>')).toBe('');
        expect(bodyOf('<p>x</p>')).toBe('<p>x</p>');
    });

    it('reads meta tags by name or property, with entities decoded', () => {
        expect(meta(SERIES, 'description')).toEqual(['Fish & chips.']);
        expect(meta(SERIES, 'og:image')).toEqual(['https://example.test/media/x/w1200.webp']);
        expect(meta(SERIES, 'catalog-revision')).toEqual([A]);
        expect(meta(SERIES, 'robots')).toEqual([]);
    });

    it('reads markers from tags only, never from a script or the Flight payload', () => {
        expect(markers(SERIES)).toEqual({ meta: [A], main: [A], list: [], homeState: [], revisions: [A, B] });
    });

    it("counts each marker every time it's there, wherever it is", () => {
        const twice = SERIES.replace('</body>', `<meta name="catalog-revision" content="${B}"/><main data-catalog-revision="${B}"></main></body>`);
        expect(markers(twice)).toMatchObject({ meta: [A, B], main: [A, B] });
        // The second meta streamed into the body, so the head holds only the first.
        expect(meta(headOf(twice), 'catalog-revision')).toEqual([A]);
        expect(meta(bodyOf(twice), 'catalog-revision')).toEqual([B]);
    });

    it("reads Work's list and Home's state", () => {
        const html = `<html><head></head><body><main data-home-state='ready' data-catalog-revision=${A}><ul class="list" data-catalog-revision="${A}"><li>x</li></ul></main></body></html>`;
        expect(markers(html)).toEqual({ meta: [], main: [A], list: [A], homeState: ['ready'], revisions: [A] });
    });
});

describe("the error shell's skeleton", () => {
    const shell = (scripts: number, inBody = '') =>
        `<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>${'<link rel="preload" as="script" href="/c.js"/>'.repeat(scripts)}${'<script src="/c.js" async=""></script>'.repeat(scripts)}</head><body>${inBody}${'<script>self.__next_f.push([1,"x"])</script>'.repeat(scripts)}</body></html>`;

    it('is the same with any number of chunks', () => {
        expect(skeleton(shell(2))).toEqual(skeleton(shell(5)));
        expect(skeleton(shell(2))).toEqual(['html', 'head', 'meta', 'meta', 'body']);
    });

    it('differs once the title or a hidden segment streams into the body', () => {
        expect(skeleton(shell(2, '<div hidden id="S:0"><title>Work · Site</title></div>'))).not.toEqual(skeleton(shell(2)));
    });
});

/**
 * The Viewer's body as B8 renders it on a page (ViewerChrome's header, the
 * photograph's <picture>, and the reading area), then a Flight payload
 * naming tags of its own, which no reader may count.
 */
const VIEWER = [
    '</head><body class="font-sans">',
    '<main data-surface="viewer" data-viewer-mode="page" class="StoryViewer_viewer">',
    '<header class="ViewerChrome_header"><a class="ViewerChrome_control" href="/work/harbor?photo=ph_x"><svg aria-hidden="true" width="18"></svg>Close</a>',
    '<div class="ViewerChrome_heading"><h1 class="ViewerChrome_series">Harbor<span class="sr-only ViewerChrome_spokenPosition">, photograph 2 of 3</span></h1>',
    '<p class="ViewerChrome_position"><span aria-hidden="true">02 / 03</span></p></div>',
    '<button type="button" class="ViewerChrome_control ViewerChrome_zoom" aria-pressed="false"><svg aria-hidden="true"></svg>Zoom</button></header>',
    '<div class="StoryViewer_viewport" data-viewer-stage=""><div class="StoryViewer_track" data-viewer-track=""><picture>',
    '<source type="image/avif" srcSet="/media/ph_x/sha256-a/p_1/w640.avif 640w, /media/ph_x/sha256-a/p_1/w1200.avif 1200w" sizes="100vw"/>',
    '<source type="image/webp" srcSet="/media/ph_x/sha256-a/p_1/w640.webp 640w, /media/ph_x/sha256-a/p_1/w1200.webp 1200w" sizes="100vw"/>',
    '<img src="/media/ph_x/sha256-a/p_1/w1200.webp" width="2400" height="1600" alt="Boats &amp; a wall." loading="eager"/></picture></div></div>',
    '<section class="StoryViewer_reading" aria-labelledby="_R_1"><div class="StoryViewer_lead"><h2 id="_R_1" class="sr-only">Photograph 2 of 3</h2>',
    '<p class="StoryViewer_caption">Morning &amp; the wall.</p></div></section></main>',
    '<script>self.__next_f.push([1,"<h1>Not this</h1><img alt=\\"not this\\"><span aria-hidden=\\"true\\">09 / 09</span><p>Nor this.</p>"])</script>',
    '</body></html>',
].join('');

describe("the Viewer's markup", () => {
    it('reads the h1 with its sr-only position, the aria-hidden counter, the caption, the alt, and both sources, from tags only', () => {
        const found = viewerMarkup(VIEWER);
        expect(found.headings).toEqual([{ text: 'Harbor, photograph 2 of 3', spoken: [', photograph 2 of 3'] }]);
        expect(found.hiddenText).toEqual(['02 / 03']);
        expect(found.paragraphs).toEqual(['Morning & the wall.']);
        expect(found.alts).toEqual(['Boats & a wall.']);
        expect(found.sources.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
        expect(srcsetCandidates(found.sources[0].srcset)).toEqual([
            { url: '/media/ph_x/sha256-a/p_1/w640.avif', width: 640 },
            { url: '/media/ph_x/sha256-a/p_1/w1200.avif', width: 1200 },
        ]);
    });

    it('counts a heading with no spoken position, and a page with no photograph, as they are', () => {
        const placeOnly = VIEWER.replace('<span class="sr-only ViewerChrome_spokenPosition">, photograph 2 of 3</span>', '').replace(/<picture>[\s\S]*<\/picture>/, '');
        const found = viewerMarkup(placeOnly);
        expect(found.headings).toEqual([{ text: 'Harbor', spoken: [] }]);
        expect(found.alts).toEqual([]);
        expect(found.sources).toEqual([]);
    });

    it('reads a srcset with extra whitespace, and nothing from an empty one', () => {
        expect(srcsetCandidates(' /media/a.webp 640w ,\n/media/b.webp 1200w ')).toEqual([
            { url: '/media/a.webp', width: 640 },
            { url: '/media/b.webp', width: 1200 },
        ]);
        expect(srcsetCandidates('')).toEqual([]);
    });

    it('hears only the sr-only span as spoken, so a position shown on screen never counts as the spoken one', () => {
        const shown = VIEWER.replace('<span class="sr-only ViewerChrome_spokenPosition">', '<span class="ViewerChrome_spokenPosition">');
        expect(viewerMarkup(shown).headings).toEqual([{ text: 'Harbor, photograph 2 of 3', spoken: [] }]);
    });

    it("reads a density candidate's width as NaN, so a srcset in x descriptors fails the width check", () => {
        expect(srcsetCandidates('/media/a.webp 2x')).toEqual([{ url: '/media/a.webp', width: Number.NaN }]);
    });
});

describe("E1's bare error shell, after </head>", () => {
    /** The real body with `extra` streamed into its hidden div, as a late metadata segment lands. */
    const streamed = (extra: string) => WORK_ERROR_BODY.replace('<!--$--><!--/$--></div>', `<!--$--><!--/$-->${extra}</div>`);

    it("passes /work's real body: one hidden div holding an empty Suspense boundary, then the scripts", () => {
        expect(errorShellProblems(WORK_ERROR_BODY)).toEqual([]);
        // Whitespace and boundary comments only, however many, are still empty.
        expect(errorShellProblems('<body><div hidden="">\n  <!--$-->\n<!--/$--><!--$--><!--/$--></div></body>')).toEqual([]);
        expect(errorShellProblems('<body><div hidden></div></body>')).toEqual([]);
    });

    it('fails a title streamed into the hidden div', () => {
        const body = streamed('<title>Work · Keyur Golani Photography</title>');
        expect(errorShellProblems(body)).toEqual(['a <title> after </head>', 'a hidden div holding more than an empty boundary: <!--$--><!--/$--><title>Work · Keyur Golani Photography</title>']);
        // And its tags aren't the real shell's.
        expect(skeleton(body)).not.toEqual(skeleton(WORK_ERROR_BODY));
    });

    it('fails a meta tag after </head>, inside the hidden div or out', () => {
        expect(errorShellProblems(streamed('<meta name="description" content="Photographic series by Keyur Golani."/>'))).toEqual([
            'a <meta> after </head>',
            'a hidden div holding more than an empty boundary: <!--$--><!--/$--><meta name="description" content="Photographic series by Keyur Golani."/>',
        ]);
        expect(errorShellProblems(WORK_ERROR_BODY.replace('</body>', '<meta name="robots" content="noindex"/></body>'))).toEqual(['a <meta> after </head>']);
    });

    it('reads markup only, never a script', () => {
        const scripted = WORK_ERROR_BODY.replace('<script id="_R_"></script>', '<script id="_R_">document.title="<title>x</title><meta name=x>"</script>');
        expect(errorShellProblems(scripted)).toEqual([]);
    });
});

describe('a refused publish, for the log', () => {
    // Slot 4's R3 publish, which said only "1 error blocks the publish.".
    const conflict = {
        code: 'working.conflicts',
        severity: 'error' as const,
        record: { kind: 'series' as const, id: 'ser_fixture-01' },
        field: 'statement',
        message: 'This field changed both here and in the active revision, in different ways.',
        hint: 'Settle the field, then delete its conflicts entry.',
    };

    it('names each blocking rule, its record and field, and its message, after the outcome', () => {
        const warning = { ...conflict, code: 'series.statement.long', severity: 'warning' as const, message: 'Long.' };
        expect(blockingText({ outcome: 'VALIDATION_FAILED', message: '1 error blocks the publish.', issues: [warning, conflict] })).toBe(
            'VALIDATION_FAILED: 1 error blocks the publish.\n  working.conflicts on series ser_fixture-01, statement: This field changed both here and in the active revision, in different ways.',
        );
    });

    it('says the outcome and message alone when no issue blocks', () => {
        expect(blockingText({ outcome: 'CATALOG_LOCKED', message: 'Another publish holds the lock.', issues: [] })).toBe('CATALOG_LOCKED: Another publish holds the lock.');
    });
});

describe("C1's window rule", () => {
    // Publish 1 wrote its pending activation at 10 and its pointer by 12; publish 2 at 20 and 22.
    const publishes: PublishTimes[] = [
        { afterStep10: 10, afterStep11: 12 },
        { afterStep10: 20, afterStep11: 22 },
    ];

    it('allows only R0 before the first publish starts its pointer', () => {
        expect(servableRevisions(publishes, 0, 5)).toEqual([0]);
        // Up to the moment publish 1's pending activation is written, R1 can't be there yet.
        expect(servableRevisions(publishes, 0, 9.9)).toEqual([0]);
        expect(servableRevisions(publishes, 0, 10)).toEqual([0, 1]);
    });

    it('allows both sides of a pointer write the fetch overlaps', () => {
        expect(servableRevisions(publishes, 11, 11.5)).toEqual([0, 1]);
        expect(servableRevisions(publishes, 21, 21)).toEqual([1, 2]);
    });

    it('allows only R1 between the publishes', () => {
        expect(servableRevisions(publishes, 13, 15)).toEqual([1]);
        // At exactly afterStep11 the old pointer may just have been replaced.
        expect(servableRevisions(publishes, 12, 15)).toEqual([0, 1]);
    });

    it('leaves the last revision open-ended, and allows every revision to a fetch spanning the burst', () => {
        expect(servableRevisions(publishes, 25, 30)).toEqual([2]);
        expect(servableRevisions(publishes, 5, 30)).toEqual([0, 1, 2]);
    });

    it('allows R0 alone when nothing was published', () => {
        expect(servableRevisions([], 0, 100)).toEqual([0]);
    });
});
