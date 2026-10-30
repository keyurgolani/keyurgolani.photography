'use client';

import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { ViewerMode } from './viewerContext';
import { markNavigatingAway } from './viewerShellLoader';

/**
 * What the host renders when the shell or its styles couldn't load (viewerShellLoader). Over the series, it paints
 * nothing, so the series stays as it was, and loads the photo's own page instead: a normal navigation to the URL the
 * photo link points at, whose page links the Viewer's styles from the server. A photo page loaded directly already
 * has its HTML and styles from the server, so it keeps its content and never loads itself again.
 */
export default function ViewerShellFallback({ mode, children }: { mode: ViewerMode; children: ReactNode }) {
    const pathname = usePathname();
    useEffect(() => {
        if (mode !== 'modal') return;
        markNavigatingAway();
        window.location.assign(pathname);
    }, [mode, pathname]);
    return mode === 'modal' ? null : children;
}
