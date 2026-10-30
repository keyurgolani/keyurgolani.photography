import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewerStylesReady } from '../viewerStyles';

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

    it('waits for the sheet however long it takes, and settles once it applies', async () => {
        vi.useFakeTimers();
        addSheet('.other { color: red; }');
        const ready = viewerStylesReady();
        expect(await settledAfter(ready, 5000), 'no sheet, no shell').toBe(false);
        // A rule merged into a selector list still counts.
        addSheet('.x, .viewer_hash { display: grid; }');
        expect(await settledAfter(ready, 50), 'the sheet applies').toBe(true);
    });

    it('settles on the sheet arriving, not on a rule that only names the class inside another selector', async () => {
        vi.useFakeTimers();
        addSheet('body:has(.viewer_hash) { color: red; } .viewer_hash .image { display: block; }');
        expect(await settledAfter(viewerStylesReady(), 500)).toBe(false);
    });
});
