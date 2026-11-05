// @vitest-environment node
/**
 * test/helpers/requestUrl.ts, the reflection check's view of a page: Next's
 * `c` and `q` come out of the parsed root flight row, and only they do.
 * The pages here are built the way Next writes them: the flight stream in
 * `self.__next_f.push([1, chunk])` scripts, JSON-stringified and HTML-escaped,
 * cut anywhere, with length-prefixed text rows that can hold newlines.
 */
import { describe, expect, it } from 'vitest';
import { withoutRequestUrl } from './helpers/requestUrl';

const ID = 'ph_00000000-0000-4000-8000-000000000999';
const HOSTILE = '"><img src=x onerror=alert(1)>';
const PATH = '/work/long';

/** Next's two fields for `?photo=<value>` (app-render.js prepareInitialCanonicalUrl() and getRenderedSearch()). */
const fieldsFor = (value: string) => ({
    c: `${PATH}?${new URLSearchParams({ photo: value })}`.split('/'),
    q: `?photo=${encodeURIComponent(value)}`,
});

/** Next's htmlEscapeJsonString(). */
const escapeHtml = (json: string) => json.replace(/[&<>\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A text row: `id:T<hex byte length>,<text>`, with no newline after it. */
const textRow = (id: string, text: string) => `${id}:T${Buffer.byteLength(text).toString(16)},${text}`;

interface PageOptions {
    root?: Record<string, unknown>;
    rows?: string[];
    markup?: string;
    /** The root row's id, `0` as Next writes it. */
    rootId?: string;
}

/** A page for `?photo=<value>`, its flight stream cut into three pushes, one of them mid-row. */
function page(value: string, { root = {}, rows = [], markup = '', rootId = '0' }: PageOptions = {}): string {
    // A text row has no newline after it; every other row ends with one.
    const stream =
        '1:"$Sreact.fragment"\n' +
        // A hint row, with no id.
        ':HL["/_next/static/chunks/fixture.css","style"]\n' +
        textRow('2', 'a caption\nover two lines é') +
        [`${rootId}:${JSON.stringify({ P: null, ...fieldsFor(value), i: false, t: { t: { s: '' } }, ...root })}`, '3:["$","main",null,{"children":"Fixture long series"}]', ...rows]
            .map((row) => `${row}\n`)
            .join('');
    const cuts = [0, 7, Math.floor(stream.length / 2), stream.length];
    const pushes = cuts.slice(1).map((end, n) => `<script>self.__next_f.push(${escapeHtml(JSON.stringify([1, stream.slice(cuts[n], end)]))})</script>`);
    return `<!DOCTYPE html><html><head></head><body><main><h1>Fixture long series</h1>${markup}</main><script>(self.__next_f=self.__next_f||[]).push([0])</script>${pushes.join('')}</body></html>`;
}

/** The root flight row's fields in a withoutRequestUrl() view. */
function rootOf(view: string): Record<string, unknown> {
    const line = view.split('\n').find((row) => row.startsWith('0:'));
    if (!line) throw new Error('no root row in the view');
    return JSON.parse(line.slice(2)) as Record<string, unknown>;
}

describe('withoutRequestUrl', () => {
    it.each([ID, 'not-a-photo', HOSTILE])('takes c and q out of the parsed root row for %j, so the value is nowhere else', (value) => {
        const html = page(value);
        expect(html).toContain(encodeURIComponent(value).slice(0, 12));
        const view = withoutRequestUrl(html, PATH, { photo: value });
        for (const form of [value, encodeURIComponent(value), new URLSearchParams({ photo: value }).toString(), ...(value === HOSTILE ? ['onerror'] : [])]) {
            expect(view).not.toContain(form);
        }
    });

    it('keeps every other root field, and every other row, decoded', () => {
        const view = withoutRequestUrl(page(ID), PATH, { photo: ID });
        expect(rootOf(view)).toEqual({ P: null, i: false, t: { t: { s: '' } } });
        expect(view).toContain('<h1>Fixture long series</h1>');
        expect(view).toContain('1:"$Sreact.fragment"');
        expect(view).toContain(':HL["/_next/static/chunks/fixture.css","style"]');
        expect(view).toContain('a caption\nover two lines é');
        expect(view).toContain('3:["$","main",null,{"children":"Fixture long series"}]');
        // The flight scripts are read, not left in as they were.
        expect(view).not.toContain('self.__next_f.push([1,');
    });

    describe.each([ID, 'not-a-photo', HOSTILE])('a product echo of %j still shows', (value) => {
        const typed = value === HOSTILE ? 'onerror' : value;

        it('in an href in the markup', () => {
            const html = page(value, { markup: `<a href="${PATH}?${new URLSearchParams({ photo: value })}">Back</a>` });
            expect(withoutRequestUrl(html, PATH, { photo: value })).toContain(new URLSearchParams({ photo: value }).toString());
        });

        it('in a client prop, in a row of its own', () => {
            const html = page(value, { rows: [`4:["$","a",null,{"href":${JSON.stringify(`${PATH}?photo=${encodeURIComponent(value)}`)},"data-focus":${JSON.stringify(value)}}]`] });
            const view = withoutRequestUrl(html, PATH, { photo: value });
            expect(view).toContain(typed);
            expect(view).toContain(encodeURIComponent(value));
        });

        it('in a field of the root row beside c and q', () => {
            const html = page(value, { root: { focusPhotoId: value } });
            const view = withoutRequestUrl(html, PATH, { photo: value });
            expect(rootOf(view).focusPhotoId).toBe(value);
            expect(view).toContain(typed);
        });
    });

    describe('fails loudly when Next stops writing the URL where it did', () => {
        it('with no flight scripts', () => {
            expect(() => withoutRequestUrl('<html><body><main></main></body></html>', PATH, { photo: ID })).toThrow(/flight/);
        });

        it('with no root row', () => {
            const html = page(ID, { rootId: '9' });
            expect(() => withoutRequestUrl(html, PATH, { photo: ID })).toThrow(/root/);
        });

        it.each(['c', 'q'])('with no %s field', (field) => {
            expect(() => withoutRequestUrl(page(ID, { root: { [field]: undefined } }), PATH, { photo: ID })).toThrow(new RegExp(`\\b${field}\\b`));
        });

        it.each([
            ['c', ['', 'work', 'long']],
            ['c', ['', 'work', `long?photo=${ID.replace('999', '998')}`]],
            ['q', ''],
            ['q', `?photo=${ID.replace('999', '998')}`],
        ])("when %s doesn't hold the value (%j)", (field, held) => {
            expect(() => withoutRequestUrl(page(ID, { root: { [field]: held } }), PATH, { photo: ID })).toThrow(new RegExp(`\\b${field}\\b`));
        });

        it('when a flight script is not JSON', () => {
            const html = page(ID).replace('self.__next_f.push([1,', 'self.__next_f.push([1,,');
            expect(() => withoutRequestUrl(html, PATH, { photo: ID })).toThrow();
        });
    });
});
