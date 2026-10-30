'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { markNavigatingAway } from './viewerShellLoader';

/**
 * What the host renders over the series when the shell or its styles couldn't load (viewerShellLoader). It paints
 * nothing, so the series stays as it was, and loads the photo's own page instead, whose server HTML links the Viewer's
 * styles. It replaces the history entry the open just pushed, so one Back returns to the series (#128's review, M3).
 */
export default function ViewerShellFallback() {
    const pathname = usePathname();
    useEffect(() => {
        markNavigatingAway();
        window.location.replace(pathname);
    }, [pathname]);
    return null;
}
