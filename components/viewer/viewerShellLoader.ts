import type { ReactNode } from 'react';
import type { ViewerMode } from './viewerContext';
import ViewerShellFallback from './ViewerShellFallback';

/**
 * The Viewer's shell, loaded apart from the series page: ViewerShell carries StoryViewer.module.css, so a static
 * import from ViewerHost, which sits in every series page's layout, would put the Viewer's styles in each series page's
 * first load. Loaded here, they arrive with the shell instead, which a photo link's intent and the browser's idle time
 * both ask for ahead of an open.
 *
 * Each mode's promise settles only once the shell's stylesheet applies (viewerStylesReady), so React never renders the
 * shell, and the modal never paints, without its styles: an open from the series page is a transition, which keeps the
 * series page on screen until the shell resolves. Neither rejects. When the chunk fails, or the styles don't apply in
 * time, the modal's settles on ViewerShellFallback, which loads the photo's own page, and the next intent asks again.
 * A page's never settles: hydration then stays waiting over the server's HTML, which has the Viewer's styles and whose
 * Close, Previous and Next are plain links, rather than rendering a shell it can't match (#128's review, L7).
 */
export type ViewerShellComponent = (props: { mode: ViewerMode; children: ReactNode }) => ReactNode;

let pending: Record<ViewerMode, Promise<ViewerShellComponent>> | null = null;
let controller: AbortController | null = null;
let loaded = false;
let failed = false;
let navigatingAway = false;

/** Never settles: what a page's hydration waits on when its shell can't load. */
const NEVER = new Promise<never>(() => {});

export function loadViewerShell(mode: ViewerMode): Promise<ViewerShellComponent> {
    if (pending) return pending[mode];
    const own = (controller = new AbortController());
    loaded = failed = false;
    // Only the current load writes the flags: one cancelled meanwhile settles unseen.
    const current = () => controller === own;
    const shell = Promise.all([import('./ViewerShell'), import('./viewerStyles')])
        .then(async ([module, css]): Promise<ViewerShellComponent | null> => {
            await css.viewerStylesReady(own.signal);
            if (current()) loaded = true;
            return module.default;
        })
        .catch((): null => {
            if (current()) failed = true;
            return null;
        })
        .finally(() => {
            if (current()) controller = null;
        });
    pending = {
        modal: shell.then((loadedShell) => loadedShell ?? ViewerShellFallback),
        page: shell.then((loadedShell) => loadedShell ?? NEVER),
    };
    return pending[mode];
}

/** For a photo link's intent and the idle time, never a render: after a failure, it starts a fresh load. */
export function preloadViewerShell(): void {
    if (failed && !navigatingAway) pending = null;
    void loadViewerShell('modal');
}

/** Whether the shell and its styles are in, so an open won't wait. */
export const viewerShellLoaded = (): boolean => loaded;

/** Stops a load still waiting on its styles (the host unmounting), clearing its timers and listener. */
export function cancelViewerShellLoad(): void {
    if (controller === null) return;
    controller.abort();
    controller = null;
    pending = null;
}

/** The fallback is loading the photo's page: no intent starts another load meanwhile. */
export function markNavigatingAway(): void {
    navigatingAway = true;
}
