import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Gallery', () => ({ default: ({ images }: { images: unknown[] }) => <p data-gallery={images.length} /> }));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DynamicGallery', () => {
    it('aborts its /api/photos request when the gallery unmounts, and logs nothing for it (#6)', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let signal: AbortSignal | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                signal = init?.signal ?? undefined;
                return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
            }),
        );
        const { default: DynamicGallery } = await import('../DynamicGallery');
        const { unmount } = render(<DynamicGallery />);
        expect(signal?.aborted).toBe(false);
        unmount();
        expect(signal?.aborted).toBe(true);
        await act(() => Promise.resolve());
        expect(error).not.toHaveBeenCalled();
    });

    it('still shows the list it gets', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ src: '/a.jpg', thumbnail: '/t.webp', optimized: '/o.webp', width: 3, height: 2, optimizedWidth: 3, optimizedHeight: 2 }] })));
        const { default: DynamicGallery } = await import('../DynamicGallery');
        const { container } = render(<DynamicGallery />);
        await act(() => Promise.resolve());
        await vi.waitFor(() => expect(container.querySelector('[data-gallery]')).toHaveAttribute('data-gallery', '1'));
    });
});
