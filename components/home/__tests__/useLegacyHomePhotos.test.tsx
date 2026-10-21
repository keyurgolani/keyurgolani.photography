import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const records = [
  { src: '/original-1.jpg', thumbnail: '/thumb-1.webp', optimized: '/optimized-1.webp', width: 1200, height: 800 },
  { src: '/original-2.jpg', thumbnail: '/thumb-2.webp', optimized: '/optimized-2.webp', width: 800, height: 1200 },
];

const answer = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

async function loadHook() {
  const module = await import('../useLegacyHomePhotos');
  return module.useLegacyHomePhotos;
}

const preloadLinks = () => document.head.querySelectorAll('link[rel="preload"]');

describe('useLegacyHomePhotos', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove());
  });

  it('maps each record to a HomePhoto keyed by its src, named for its place after the shuffle', async () => {
    // With random() at 0 the first-load shuffle reverses two records.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockResolvedValueOnce(answer(records));
    const useLegacyHomePhotos = await loadHook();
    const { result } = renderHook(() => useLegacyHomePhotos());

    await waitFor(() => expect(result.current).toHaveLength(2));

    expect(result.current.map((photo) => photo.id)).toEqual(['/original-2.jpg', '/original-1.jpg']);
    expect(result.current[0]).toEqual({
      id: '/original-2.jpg',
      accessibleName: 'Photograph 1 of 2',
      sources: { thumbnail: '/thumb-2.webp', full: '/optimized-2.webp' },
      width: 800,
      height: 1200,
    });
    expect(result.current[1].accessibleName).toBe('Photograph 2 of 2');
  });

  it('reuses the previous photographs immediately while refreshing in the background', async () => {
    fetchMock.mockResolvedValueOnce(answer(records));
    const useLegacyHomePhotos = await loadHook();
    const first = renderHook(() => useLegacyHomePhotos());

    await waitFor(() => expect(first.result.current).toHaveLength(2));
    const shown = first.result.current.map((photo) => photo.id);
    first.unmount();

    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const second = renderHook(() => useLegacyHomePhotos());

    expect(second.result.current.map((photo) => photo.id)).toEqual(shown);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the shown order on refresh, drops removed photos, renumbers, and returns the same array when nothing changed', async () => {
    fetchMock.mockResolvedValueOnce(answer(records));
    const useLegacyHomePhotos = await loadHook();
    const first = renderHook(() => useLegacyHomePhotos());
    await waitFor(() => expect(first.result.current).toHaveLength(2));
    const [kept] = first.result.current.filter((photo) => photo.id === '/original-2.jpg');
    first.unmount();

    fetchMock.mockResolvedValueOnce(answer([records[1]]));
    const second = renderHook(() => useLegacyHomePhotos());
    await waitFor(() => expect(second.result.current).toHaveLength(1));
    expect(second.result.current[0]).toMatchObject({ id: kept.id, accessibleName: 'Photograph 1 of 1' });
    second.unmount();

    fetchMock.mockResolvedValueOnce(answer([records[1]]));
    const third = renderHook(() => useLegacyHomePhotos());
    const cached = third.result.current;
    // The refresh preloads once it has merged, so its link marks the moment it's done.
    await waitFor(() => expect(preloadLinks()).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(third.result.current).toBe(cached);
  });

  it('unmounting clears the preload links and their timeouts', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer(records));
    const useLegacyHomePhotos = await loadHook();
    const { result, unmount } = renderHook(() => useLegacyHomePhotos());

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toHaveLength(2);
    const hrefs = Array.from(preloadLinks(), (link) => link.getAttribute('href'));
    expect(hrefs).toEqual(result.current.map((photo) => photo.sources.full));
    expect(vi.getTimerCount()).toBe(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(preloadLinks()).toHaveLength(0);
  });

  it('drops the preload links on their own after 15 s', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer(records));
    const useLegacyHomePhotos = await loadHook();
    renderHook(() => useLegacyHomePhotos());

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(preloadLinks()).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(preloadLinks()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fetch that lands after unmount adds no links and arms no timers', async () => {
    let resolve: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => (resolve = done)));
    vi.useFakeTimers();
    const useLegacyHomePhotos = await loadHook();
    const { unmount } = renderHook(() => useLegacyHomePhotos());
    unmount();

    await act(async () => {
      resolve(answer(records));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(preloadLinks()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
