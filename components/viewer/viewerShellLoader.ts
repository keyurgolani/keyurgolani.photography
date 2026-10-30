/**
 * The Viewer's shell, loaded apart from the series page: ViewerShell carries StoryViewer.module.css, so a static
 * import from ViewerHost, which sits in every series page's layout, would put the Viewer's styles in each series page's
 * first load. Loaded here, they arrive with the shell instead, which a photo link's intent and the browser's idle time
 * both ask for ahead of an open.
 *
 * The promise settles only once the shell's stylesheet applies (viewerStylesReady), so React never renders the shell,
 * and the modal never paints, without its styles: an open from the series page is a transition, which keeps the series
 * page on screen until the shell resolves. A failed load forgets the promise, so the next ask tries again.
 */
type ShellModule = typeof import('./ViewerShell');

let pending: Promise<{ default: ShellModule['default'] }> | null = null;

export function loadViewerShell(): Promise<{ default: ShellModule['default'] }> {
    pending ??= Promise.all([import('./ViewerShell'), import('./viewerStyles')]).then(
        async ([shell, css]) => {
            await css.viewerStylesReady();
            return { default: shell.default };
        },
        (error: unknown) => {
            pending = null;
            throw error;
        },
    );
    return pending;
}
