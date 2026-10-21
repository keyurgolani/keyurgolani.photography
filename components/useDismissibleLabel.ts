'use client';

import { useEffect, useState } from 'react';

/** Hides a dismissed label over the hover and focus rules that show it. */
export const DISMISSED_LABEL_STYLE = { opacity: 0, pointerEvents: 'none' } as const;

/**
 * A label that hover or focus shows. Escape hides it until the pointer
 * leaves or focus moves (WCAG 1.4.13). Spread `handlers` on the control that
 * shows the label, and give the label `DISMISSED_LABEL_STYLE` while
 * `dismissed`.
 */
export function useDismissibleLabel() {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const shown = hovered || focused;

    // Escape reaches the document wherever focus is, so a label shown on hover hides too.
    useEffect(() => {
        if (!shown) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDismissed(true);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [shown]);

    return {
        dismissed,
        handlers: {
            onPointerEnter: () => setHovered(true),
            onPointerLeave: () => {
                setHovered(false);
                setDismissed(false);
            },
            onFocus: () => setFocused(true),
            onBlur: () => {
                setFocused(false);
                setDismissed(false);
            },
        },
    };
}
