import { afterEach, describe, expect, it, vi } from 'vitest';
import { VIEWER_STYLES_DEADLINE, viewerStylesReady } from '../viewerStyles';

vi.mock('../StoryViewer.module.css', () => ({ default: { viewer: 'viewer_hash' } }));

afterEach(() => {
    vi.useRealTimers();
    document.head.innerHTML = '';
});

const addSheet = (css: string) => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

/** Whether the promise has settled after `ms` of fake time. */
async function settledAfter(promise: Promise<void>, ms: number): Promise<boolean> {
    let settled = false;
    void promise.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
}

describe('viewerStylesReady', () => {
    it("settles at once when the Viewer's stylesheet already applies, as on a direct load", async () => {
        addSheet('.viewer_hash { display: grid; }');
        await expect(viewerStylesReady()).resolves.toBeUndefined();
    });

    it('waits for the sheet, and settles once it applies', async () => {
        vi.useFakeTimers();
        addSheet('.other { color: red; }');
        const ready = viewerStylesReady();
        expect(await settledAfter(ready, VIEWER_STYLES_DEADLINE - 1000), 'no sheet, no shell').toBe(false);
        // A rule merged into a selector list still counts.
        addSheet('.x, .viewer_hash { display: grid; }');
        expect(await settledAfter(ready, 50), 'the sheet applies').toBe(true);
    });

    it('settles on the sheet arriving, not on a rule that only names the class inside another selector', async () => {
        vi.useFakeTimers();
        addSheet('body:has(.viewer_hash) { color: red; } .viewer_hash .image { display: block; }');
        expect(await settledAfter(viewerStylesReady(), 500)).toBe(false);
    });
    it('gives up at the deadline, and clears its timers and its listener', async () => {
        vi.useFakeTimers();
        const removed = vi.spyOn(document, 'removeEventListener');
        const ready = viewerStylesReady();
        const outcome = ready.then(() => 'ready', (error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(VIEWER_STYLES_DEADLINE);
        expect(await outcome).toMatch(/didn't apply/);
        expect(vi.getTimerCount(), 'no poll or deadline left').toBe(0);
        expect(removed).toHaveBeenCalledWith('load', expect.any(Function), true);
    });

    it('stops at once when its signal aborts, and clears the same way', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const outcome = viewerStylesReady(controller.signal).then(() => 'ready', () => 'stopped');
        controller.abort();
        expect(await outcome).toBe('stopped');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('scans again on a stylesheet load, never on an image load', async () => {
        vi.useFakeTimers();
        const scans = vi.spyOn(document, 'styleSheets', 'get');
        void viewerStylesReady();
        const before = scans.mock.calls.length;
        document.dispatchEvent(new Event('load'));
        document.body.appendChild(document.createElement('img')).dispatchEvent(new Event('load'));
        expect(scans.mock.calls.length, 'an image').toBe(before);
        document.head.appendChild(document.createElement('link')).dispatchEvent(new Event('load'));
        expect(scans.mock.calls.length, 'a stylesheet').toBeGreaterThan(before);
        scans.mockRestore();
    });
});
