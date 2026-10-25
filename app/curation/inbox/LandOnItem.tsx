'use client';

import { useEffect } from 'react';

/**
 * Brings the item into view when the URL asks for it (`#item`, every row's
 * link). The page streams in behind its loading state, so the browser's own
 * jump to the fragment finds nothing to scroll to and leaves the curator at
 * the top of the list; this does the jump once the item is there. It also
 * moves focus to the item, so a keyboard's next Tab goes into its form and not
 * through every row again.
 */
export default function LandOnItem({ targetId }: { targetId: string }) {
    useEffect(() => {
        if (window.location.hash !== `#${targetId}`) return;
        const target = document.getElementById(targetId);
        if (!target) return;
        target.scrollIntoView({ block: 'start' });
        target.focus({ preventScroll: true });
    }, [targetId]);
    return null;
}
