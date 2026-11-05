// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artist } from '@/data/artist';

// About's own metadata (#12): the title, the approved statement heading as the
// description (owner, 2026-11-04: "A curious soul"), and the canonical path,
// which is left out without a valid SITE_URL, as on the series and Viewer pages.

const state = vi.hoisted(() => ({ origin: null as URL | null }));

vi.mock('@/lib/site/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/site/config')>();
  return { ...actual, getSiteOrigin: () => state.origin };
});

const { generateMetadata } = await import('../page');

afterEach(() => {
  state.origin = null;
});

describe('the /about metadata', () => {
  it('with SITE_URL set gives the title, the statement heading as the description, and the canonical path /about', async () => {
    state.origin = new URL('https://photos.example.test');
    expect(await generateMetadata()).toEqual({
      title: 'About',
      description: artist.profile.statementHeading,
      alternates: { canonical: '/about' },
    });
  });

  it('leaves the canonical link out without a valid SITE_URL, instead of pointing it at localhost', async () => {
    const metadata = await generateMetadata();
    expect(metadata).toEqual({ title: 'About', description: artist.profile.statementHeading });
    expect(JSON.stringify(metadata)).not.toMatch(/localhost|https?:/);
  });
});
