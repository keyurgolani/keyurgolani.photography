import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long a live region keeps a message before it's emptied again (#246): Home's carousel and the Viewer's status.
 * Text in a region stays in the reading order, so a screen reader reading on would meet the message a second time,
 * after the slide or the photograph it describes. A screen reader queues a polite message when the browser reports the
 * change, so the text has to stay only until then: 3 s leaves room for a slow device and a busy screen reader, and is
 * still short enough that reading on after a move seldom meets it. An emptied region says nothing.
 */
export const LIVE_HOLD_MS = 3000;
/** A repeated message clears the region and lands again this long after, so a screen reader hears it again (bug 3). */
export const REPEAT_GAP_MS = 100;

type Timer = ReturnType<typeof setTimeout>;

export interface LiveMessage {
    /** The region's text: empty except while a message is being announced. */
    message: string;
    /**
     * Puts `text` in the region at once, and empties it LIVE_HOLD_MS later. Text the region still holds is cleared
     * first and set REPEAT_GAP_MS later, so a repeat that comes before the clear is still a change, and heard (bug 3).
     */
    say: (text: string) => void;
    /** Drops a repeat still waiting to land. What the region holds stays until its own clear. */
    drop: () => void;
}

/** One live region's text, held only while it's being announced (#246). */
export function useLiveMessage(): LiveMessage {
    const [message, setMessage] = useState('');
    /** What the region holds, or is about to hold again after a repeat's gap. Empty once it's cleared. */
    const held = useRef('');
    const gap = useRef<Timer | null>(null);
    const hold = useRef<Timer | null>(null);

    const drop = useCallback(() => {
        if (gap.current !== null) clearTimeout(gap.current);
        gap.current = null;
    }, []);
    const show = useCallback((text: string) => {
        setMessage(text);
        hold.current = setTimeout(() => {
            hold.current = null;
            held.current = '';
            setMessage('');
        }, LIVE_HOLD_MS);
    }, []);
    const say = useCallback(
        (text: string) => {
            drop();
            if (hold.current !== null) clearTimeout(hold.current);
            hold.current = null;
            if (text !== held.current) {
                held.current = text;
                show(text);
                return;
            }
            setMessage('');
            gap.current = setTimeout(() => {
                gap.current = null;
                show(text);
            }, REPEAT_GAP_MS);
        },
        [drop, show],
    );
    useEffect(
        () => () => {
            drop();
            if (hold.current !== null) clearTimeout(hold.current);
        },
        [drop],
    );
    return { message, say, drop };
}
