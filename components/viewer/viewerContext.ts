'use client';

import { createContext } from 'react';
// Types only: the projection pulls the catalog schema and node:crypto in, which must stay out of the client bundle.
import type { ViewerImage } from '@/lib/catalog/projections/viewer';

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
    /** The series' canonical slug and the revision this photograph came from, which the neighbors' peeks are asked for in (9a). */
    seriesSlug: string;
    revisionId: string;
    /** The neighbors, by ID, or null at an end. */
    previousPhotoId: string | null;
    nextPhotoId: string | null;
    /** This photograph's own set, so it can peek back in once the Viewer has moved on from it. */
    image: ViewerImage | null;
}

/** A photograph as it peeks in beside the one under the finger (9a): its set (null for the missing-image box) and accent. */
export interface ViewerPeek {
    image: ViewerImage | null;
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
    /**
     * The neighbors that peek in, by photo ID, once a visitor has touched the photograph or moved. Empty under reduced
     * motion, where nothing follows the finger, and until then, so a first load shows one photograph (#6).
     */
    peeks: ReadonlyMap<string, ViewerPeek>;
}

/** Null outside a shell, where StoryViewer renders the whole Viewer on its own. */
export const ViewerContext = createContext<ViewerShellContext | null>(null);
