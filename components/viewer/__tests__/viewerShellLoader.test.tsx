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
        const Shell = await loader.loadViewerShell('modal');
        expect(loader.viewerShellLoaded()).toBe(true);
        expect(Shell.name).toBe('RealShell');
    });

    it('never rejects: a late sheet settles on the fallback, and the next intent asks again', async () => {
        chunk.styles = 'fail';
        const loader = await fresh();
        const Fallback = await loader.loadViewerShell('modal');
        expect(loader.viewerShellLoaded()).toBe(false);
        expect(Fallback.name).toBe('ViewerShellFallback');
        // A render asks for the same settled load, so it never starts another.
        expect(await loader.loadViewerShell('modal')).toBe(Fallback);
        chunk.styles = 'ok';
        loader.preloadViewerShell();
        expect((await loader.loadViewerShell('modal')).name).toBe('RealShell');
    });

    it('settles on the fallback when the chunk fails too', async () => {
        vi.doMock('../ViewerShell', () => {
            throw new Error('chunk failed');
        });
        try {
            const loader = await fresh();
            expect((await loader.loadViewerShell('modal')).name).toBe('ViewerShellFallback');
        } finally {
            vi.doMock('../ViewerShell', () => realShell());
        }
    });

    it("cancels a load still waiting on its styles, and a cancelled load doesn't mark the next one", async () => {
        chunk.styles = 'hold';
        const loader = await fresh();
        const first = loader.loadViewerShell('modal');
        await vi.waitFor(() => expect(chunk.signals).toHaveLength(1));
        loader.cancelViewerShellLoad();
        expect(chunk.signals[0].aborted).toBe(true);
        chunk.styles = 'ok';
        const second = loader.loadViewerShell('modal');
        expect(second).not.toBe(first);
        await first;
        expect((await second).name).toBe('RealShell');
        expect(loader.viewerShellLoaded()).toBe(true);
    });

    it("the fallback loads the photo's own page over the series in place of the open's entry, and paints nothing", async () => {
        const replace = vi.fn();
        vi.stubGlobal('location', { ...window.location, replace, assign: vi.fn() });
        const { default: ViewerShellFallback } = await import('../ViewerShellFallback');
        const view = render(<ViewerShellFallback />);
        expect(view.container).toBeEmptyDOMElement();
        expect(replace).toHaveBeenCalledWith('/work/harbor/photo/a');
        expect(window.location.assign).not.toHaveBeenCalled();
    });

    it("a photo page whose shell can't load never settles, so hydration waits over the server's HTML", async () => {
        chunk.styles = 'fail';
        const loader = await fresh();
        const page = loader.loadViewerShell('page');
        let settled = false;
        void page.then(() => (settled = true));
        expect((await loader.loadViewerShell('modal')).name, 'the modal of the same load falls back').toBe('ViewerShellFallback');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        // Hydrating over the server's form: nothing is replaced and nothing mismatches.
        const { hydrateRoot } = await import('react-dom/client');
        const { use, act } = await import('react');
        const html = '<main data-viewer-mode="page"><a href="/work/harbor">Close</a><a href="/work/harbor/photo/b">Next photograph</a></main>';
        const container = document.body.appendChild(document.createElement('div'));
        container.innerHTML = html;
        const errors: unknown[] = [];
        function Host() {
            const Shell = use(loader.loadViewerShell('page'));
            return <Shell mode="page">content</Shell>;
        }
        await act(async () => {
            hydrateRoot(container, <Host />, { onRecoverableError: (error) => errors.push(error) });
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(container.innerHTML).toBe(html);
        expect(errors).toEqual([]);
        container.remove();
    });
});
