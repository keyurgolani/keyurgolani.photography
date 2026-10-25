// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopyStatus } from '@/data/artist';
import { PROVISIONAL_COPY_MESSAGE } from '@/utils/artistProfile';

// The gate has to run where next build evaluates it: at module scope in
// app/about/page.tsx. Importing the page under production is what the build
// does, so these fail if the call goes, or moves into the component. The
// profile's copyStatus is mocked, so they hold before and after the owner's
// copy lands.

async function importPageWith(copyStatus: CopyStatus) {
  vi.resetModules();
  vi.doMock('@/data/artist', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/data/artist')>();
    return { ...original, artist: { ...original.artist, profile: { ...original.artist.profile, copyStatus } } };
  });
  return import('../page');
}

afterEach(() => {
  vi.doUnmock('@/data/artist');
  vi.unstubAllEnvs();
});

describe('app/about/page.tsx', () => {
  it('refuses to load under production with provisional copy', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_PROVISIONAL_COPY', '');
    await expect(importPageWith('provisional')).rejects.toThrow(PROVISIONAL_COPY_MESSAGE);
  });

  it('loads under production with provisional copy when ALLOW_PROVISIONAL_COPY is 1', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_PROVISIONAL_COPY', '1');
    await expect(importPageWith('provisional')).resolves.toHaveProperty('default');
  });

  it('loads under production with approved copy and no override', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_PROVISIONAL_COPY', '');
    await expect(importPageWith('approved')).resolves.toHaveProperty('default');
  });
});
