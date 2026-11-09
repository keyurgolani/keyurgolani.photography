// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The Publish page before anything is live: the first publish has no legacy site to replace since #13's slice E.

vi.mock('@/lib/curation/auth', () => ({ requireCurator: async () => ({}) }));
vi.mock('../load', () => ({ loadPublishPage: async () => ({ state: 'not-launched' }) }));
vi.mock('../actions', () => ({ publishAction: async () => undefined, restoreAction: async () => undefined }));
vi.mock('../../CuratorHeader', () => ({ default: () => <header /> }));

const { default: PublishPage } = await import('../page');

describe('the Publish page before the first publish', () => {
    it("says what the first publish does without a legacy Home and Gallery it no longer replaces", async () => {
        const html = renderToStaticMarkup(await PublishPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('Nothing is live yet');
        expect(html).not.toMatch(/legacy/i);
        expect(html).toContain('Until the first publish, Home and Work show an error page.');
        expect(html).toContain('photos publish --confirm-launch');
    });
});
