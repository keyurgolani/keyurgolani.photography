'use client';

import { createContext } from 'react';

export type ViewerMode = 'page' | 'modal';

/**
 * What one photograph tells the Viewer's shell when it mounts, so the shell's
 * controls, which outlive every move, show this photograph's position and
 * neighbors. Previous and next are hrefs, or null at an end.
 */
export interface ViewerChromeState {
    photoId: string;
    seriesTitle: string;
    closeHref: string;
    previousHref: string | null;
    nextHref: string | null;
    position: number;
    total: number;
    /** False when the revision holds no usable set, so Zoom has nothing to enlarge. */
    hasImage: boolean;
    /** The photo's accent, else the series', already checked as `#rrggbb`. */
    accent: string | null;
}

export interface ViewerShellContext {
    mode: ViewerMode;
    /** True once the shell renders the controls itself. Until then (the server HTML and hydration) the photograph renders them. */
    claimed: boolean;
    zoomed: boolean;
    /** The id of the header line, which names the modal dialog. */
    headingId: string;
    report(state: ViewerChromeState): void;
}

/** Null outside a shell, where StoryViewer renders the whole Viewer on its own. */
export const ViewerContext = createContext<ViewerShellContext | null>(null);
