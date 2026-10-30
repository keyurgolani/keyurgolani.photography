import type { ReactNode } from 'react';
import type { ViewerMode } from './viewerContext';
import ViewerShellFallback from './ViewerShellFallback';

/**
 * The Viewer's shell, loaded apart from the series page: ViewerShell carries StoryViewer.module.css, so a static
 * import from ViewerHost, which sits in every series page's layout, would put the Viewer's styles in each series page's
 * first load. Loaded here, they arrive with the shell instead, which a photo link's intent and the browser's idle time
 * both ask for ahead of an open.
 *
 * The promise settles only once the shell's stylesheet applies (viewerStylesReady), so React never renders the shell,
 * and the modal never paints, without its styles: an open from the series page is a transition, which keeps the series
 * page on screen until the shell resolves. It never rejects. A chunk that fails, or styles that don't apply in time,
 * settle it on ViewerShellFallback, which loads the photo's own page. The next intent then asks again.
 */
export type ViewerShellComponent = (props: { mode: ViewerMode; children: ReactNode }) => ReactNode;

let pending: Promise<ViewerShellComponent> | null = null;
let controller: AbortController | null = null;
let loaded = false;
let failed = false;
let navigatingAway = false;

export function loadViewerShell(): Promise<ViewerShellComponent> {
    if (pending) return pending;
    const own = (controller = new AbortController());
    loaded = failed = false;
    // Only the current load writes the flags: one cancelled meanwhile settles unseen.
    const current = () => controller === own;
    pending = Promise.all([import('./ViewerShell'), import('./viewerStyles')])
        .then(async ([shell, css]): Promise<ViewerShellComponent> => {
            await css.viewerStylesReady(own.signal);
            if (current()) loaded = true;
            return shell.default;
        })
        .catch((): ViewerShellComponent => {
            if (current()) failed = true;
            return ViewerShellFallback;
        })
        .finally(() => {
            if (current()) controller = null;
        });
    return pending;
}

/** For a photo link's intent and the idle time, never a render: after a failure, it starts a fresh load. */
export function preloadViewerShell(): void {
    if (failed && !navigatingAway) pending = null;
    void loadViewerShell();
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
