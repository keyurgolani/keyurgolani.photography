// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_LOCATION_LENGTH, redirectLocation } from '../redirect';

// The one place a series or Viewer redirect gets its Location (#5, #7): the
// canonical path the catalog gave, and the visitor's query re-encoded after
// it, so nothing the visitor sent can change where it points.

describe('redirectLocation', () => {
    it('is the canonical path alone when there is no query', () => {
        expect(redirectLocation('/work/harbor')).toBe('/work/harbor');
        expect(redirectLocation('/work/harbor', {})).toBe('/work/harbor');
        expect(redirectLocation('/work/harbor', new URLSearchParams())).toBe('/work/harbor');
    });

    it('keeps the query, every value of a repeated key in order', () => {
        expect(redirectLocation('/work/harbor', { utm_source: 'mail', ref: 'a' })).toBe('/work/harbor?utm_source=mail&ref=a');
        expect(redirectLocation('/work/harbor', { tag: ['one', 'two'], x: '' })).toBe('/work/harbor?tag=one&tag=two&x=');
        expect(redirectLocation('/work/harbor/photo/ph_x', new URLSearchParams('photo=ph_1&b=2'))).toBe('/work/harbor/photo/ph_x?photo=ph_1&b=2');
    });

    it('skips a key Next hands over as undefined', () => {
        expect(redirectLocation('/work/harbor', { a: undefined, b: '1' })).toBe('/work/harbor?b=1');
    });

    it('re-encodes every key and value, so the query can never end the path, open a fragment, or point elsewhere', () => {
        const location = redirectLocation('/work/harbor', { next: '//evil.example/x', '#frag': 'a b&c=d', 'q?': '\r\nLocation: https://evil.example' });
        expect(location).toBe('/work/harbor?next=%2F%2Fevil.example%2Fx&%23frag=a+b%26c%3Dd&q%3F=%0D%0ALocation%3A+https%3A%2F%2Fevil.example');
        // Resolved against any origin, it stays on that origin and on the canonical path.
        const resolved = new URL(location, 'https://photos.example.test');
        expect([resolved.origin, resolved.pathname, resolved.hash]).toEqual(['https://photos.example.test', '/work/harbor', '']);
        expect(resolved.searchParams.get('next')).toBe('//evil.example/x');
    });

    it('drops the query, whole, when it would take the Location past MAX_LOCATION_LENGTH', () => {
        expect(MAX_LOCATION_LENGTH).toBe(2048);
        const path = '/work/harbor';
        // `?q=` and the value: exactly at the cap keeps the query, one character more drops all of it.
        const fits = 'x'.repeat(MAX_LOCATION_LENGTH - path.length - '?q='.length);
        expect(redirectLocation(path, { q: fits })).toHaveLength(MAX_LOCATION_LENGTH);
        expect(redirectLocation(path, { q: `${fits}x` })).toBe(path);
        expect(redirectLocation(path, { a: '1', q: `${fits}x` })).toBe(path);
        // The cap counts the re-encoded bytes: 700 spaces are 700 `+`, but 700 `/` are 2,100 characters.
        expect(redirectLocation(path, { q: ' '.repeat(700) })).toBe(`${path}?q=${'+'.repeat(700)}`);
        expect(redirectLocation(path, { q: '/'.repeat(700) })).toBe(path);
    });

    it.each([
        ['a relative path', 'work/harbor'],
        ['a protocol-relative path', '//evil.example/work'],
        ['a backslash after the slash', '/\\evil.example'],
        ['an absolute URL', 'https://evil.example/work/harbor'],
        ['a path with a query already', '/work/harbor?x=1'],
        ['a path with a fragment', '/work/harbor#x'],
        ['a path with a backslash', '/work\\harbor'],
        ['a path with a space', '/work/har bor'],
        ['a path with a newline', '/work/harbor\n'],
        ['an empty path', ''],
    ])('refuses %s as the canonical path, so a bug can\'t send a visitor off the site', (_name, path) => {
        expect(() => redirectLocation(path, { a: '1' })).toThrow(TypeError);
    });

    it('takes a preview\'s base path', () => {
        expect(redirectLocation('/curation/preview/drf_1/site/work/harbor', { a: '1' })).toBe('/curation/preview/drf_1/site/work/harbor?a=1');
    });
});
