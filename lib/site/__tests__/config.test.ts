// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function load(siteUrl: string | undefined, nodeEnv = 'production') {
  vi.resetModules();
  if (siteUrl === undefined) vi.stubEnv('SITE_URL', undefined);
  else vi.stubEnv('SITE_URL', siteUrl);
  vi.stubEnv('NODE_ENV', nodeEnv);
  return import('../config');
}

describe('lib/site/config', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('takes a valid origin', async () => {
    const { getSiteOrigin, getMetadataBase } = await load('https://example.test');
    expect(getSiteOrigin()?.href).toBe('https://example.test/');
    expect(getMetadataBase().href).toBe('https://example.test/');
  });

  it('drops a trailing slash', async () => {
    const { getSiteOrigin } = await load('https://example.test/');
    expect(getSiteOrigin()?.origin).toBe('https://example.test');
  });

  it.each([
    ['a path', 'https://example.test/photos'],
    ['a query', 'https://example.test/?a=1'],
    ['a non-http scheme', 'ftp://example.test'],
    ['no scheme', 'example.test'],
    ['credentials', 'https://user:secret@example.test'],
  ])('rejects %s', async (_, value) => {
    const { getSiteOrigin, getMetadataBase } = await load(value);
    expect(getSiteOrigin()).toBeNull();
    expect(getMetadataBase().href).toBe('http://localhost:3000/');
  });

  it('falls back to localhost without a value', async () => {
    const { getSiteOrigin, getMetadataBase } = await load(undefined);
    expect(getSiteOrigin()).toBeNull();
    expect(getMetadataBase().href).toBe('http://localhost:3000/');
  });

  it('reads SITE_URL on each call', async () => {
    const { getSiteOrigin } = await load(undefined);
    expect(getSiteOrigin()).toBeNull();
    vi.stubEnv('SITE_URL', 'https://later.test');
    expect(getSiteOrigin()?.origin).toBe('https://later.test');
  });

  it('warns once in production when the value is missing or invalid', async () => {
    const { checkSiteUrl } = await load('not a url');
    checkSiteUrl();
    checkSiteUrl();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/SITE_URL/);
  });

  it('stays quiet with a valid value, and outside production', async () => {
    const valid = await load('https://example.test');
    valid.checkSiteUrl();
    const development = await load(undefined, 'development');
    development.checkSiteUrl();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
