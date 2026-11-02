// @vitest-environment node
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

// The visitor site's response headers, from next.config.mjs. The curator's own
// entries come later and win for the keys they share (curatorBoundary.test.ts).

const ORIGIN = 'https://keyurgolani.photography';
const VISITOR_PATHS = ['/', '/work', '/work/the-palouse', '/work/the-palouse/photo/ph_x', '/about', '/gallery', '/api/photos', '/media/ph_x/sha256-x/p_x/w800.avif', '/robots.txt', '/sitemap.xml', '/no-such-page'];

describe('the visitor site headers', () => {
    it.each(VISITOR_PATHS)('sends nosniff, the referrer policy, the permissions policy, and same-origin framing only on %s', async (pathname) => {
        const response = await unstable_getResponseFromNextConfig({ url: `${ORIGIN}${pathname}`, nextConfig });
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    });

    it('keeps the curator stricter where the two share a key', async () => {
        const response = await unstable_getResponseFromNextConfig({ url: `${ORIGIN}/curation/inbox`, nextConfig });
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('lists the site-wide entry first, so every later entry overrides it', async () => {
        const entries = await nextConfig.headers!();
        expect(entries[0].source).toBe('/:path*');
    });

    it("doesn't name the framework in X-Powered-By", () => {
        expect(nextConfig.poweredByHeader).toBe(false);
    });

    // No HSTS from the app: Cloudflare terminates TLS for the site, so the owner sets it at the edge.
    it('sends no Strict-Transport-Security', async () => {
        const response = await unstable_getResponseFromNextConfig({ url: `${ORIGIN}/`, nextConfig });
        expect(response.headers.has('strict-transport-security')).toBe(false);
    });
});
