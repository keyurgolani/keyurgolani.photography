import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The loader on its own: the shell's chunk and the styles' wait are stand-ins, so each test says how they go.
const chunk = vi.hoisted(() => ({ styles: 'ok' as 'ok' | 'fail' | 'hold', signals: [] as AbortSignal[] }));
const realShell = vi.hoisted(() => () => ({ default: function RealShell() { return null; } }));
vi.mock('../ViewerShell', () => realShell());
vi.mock('../viewerStyles', () => ({
    viewerStylesReady: (signal: AbortSignal) => {
        chunk.signals.push(signal);
        if (chunk.styles === 'ok') return Promise.resolve();
        if (chunk.styles === 'fail') return Promise.reject(new Error('late'));
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
}));
const navigation = vi.hoisted(() => ({ pathname: '/work/harbor/photo/a' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

beforeEach(() => {
    vi.resetModules();
    Object.assign(chunk, { styles: 'ok', signals: [] });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const fresh = () => import('../viewerShellLoader');

describe('viewerShellLoader', () => {
    it('settles on the real shell once its styles apply, and says so', async () => {
        const loader = await fresh();
        const Shell = await loader.loadViewerShell();
        expect(loader.viewerShellLoaded()).toBe(true);
        expect(Shell.name).toBe('RealShell');
    });

    it('never rejects: a late sheet settles on the fallback, and the next intent asks again', async () => {
        chunk.styles = 'fail';
        const loader = await fresh();
        const Fallback = await loader.loadViewerShell();
        expect(loader.viewerShellLoaded()).toBe(false);
        expect(Fallback.name).toBe('ViewerShellFallback');
        // A render asks for the same settled load, so it never starts another.
        expect(await loader.loadViewerShell()).toBe(Fallback);
        chunk.styles = 'ok';
        loader.preloadViewerShell();
        expect((await loader.loadViewerShell()).name).toBe('RealShell');
    });

    it('settles on the fallback when the chunk fails too', async () => {
        vi.doMock('../ViewerShell', () => {
            throw new Error('chunk failed');
        });
        try {
            const loader = await fresh();
            expect((await loader.loadViewerShell()).name).toBe('ViewerShellFallback');
        } finally {
            vi.doMock('../ViewerShell', () => realShell());
        }
    });

    it("cancels a load still waiting on its styles, and a cancelled load doesn't mark the next one", async () => {
        chunk.styles = 'hold';
        const loader = await fresh();
        const first = loader.loadViewerShell();
        await vi.waitFor(() => expect(chunk.signals).toHaveLength(1));
        loader.cancelViewerShellLoad();
        expect(chunk.signals[0].aborted).toBe(true);
        chunk.styles = 'ok';
        const second = loader.loadViewerShell();
        expect(second).not.toBe(first);
        await first;
        expect((await second).name).toBe('RealShell');
        expect(loader.viewerShellLoaded()).toBe(true);
    });

    it("the fallback loads the photo's own page over the series, and paints nothing there", async () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { ...window.location, assign });
        const { default: ViewerShellFallback } = await import('../ViewerShellFallback');
        const view = render(<ViewerShellFallback mode="modal">modal content</ViewerShellFallback>);
        expect(view.container).toBeEmptyDOMElement();
        expect(assign).toHaveBeenCalledWith('/work/harbor/photo/a');
    });

    it('on a photo page loaded directly, it keeps the server content and never loads itself again', async () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { ...window.location, assign });
        const { default: ViewerShellFallback } = await import('../ViewerShellFallback');
        const view = render(<ViewerShellFallback mode="page">page content</ViewerShellFallback>);
        expect(view.container).toHaveTextContent('page content');
        expect(assign).not.toHaveBeenCalled();
    });
});
