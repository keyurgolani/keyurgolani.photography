import type { Page } from '@playwright/test';

/**
 * The continuous events React DOM queues while their target hasn't hydrated,
 * with the event that drops each from its queue, and whether it keys by
 * pointer. It replays the queue after hydration as a copy of the native event
 * on the same target: `target.dispatchEvent(new event.constructor(type, event))`
 * in queueIfContinuousEvent and attemptReplayContinuousQueuedEvent.
 */
const REPLAYED = [
    { over: 'focusin', out: 'focusout', byPointer: false },
    { over: 'dragenter', out: 'dragleave', byPointer: false },
    { over: 'mouseover', out: 'mouseout', byPointer: false },
    { over: 'pointerover', out: 'pointerout', byPointer: true },
    { over: 'gotpointercapture', out: 'lostpointercapture', byPointer: true },
];

/**
 * Moves the mouse just outside the viewport, where no element is under it.
 * Chromium sends a resting pointer native hovers when the content under it
 * changes, as Home's does while it loads, so a test that wants no hover at
 * all parks the pointer first.
 */
export async function parkPointer(page: Page): Promise<void> {
    await page.mouse.move(-1, -1);
}

/** What the copy takes from the native event, so a match is a copy of that one event. */
const COPIED = ['bubbles', 'cancelable', 'clientX', 'clientY', 'screenX', 'screenY', 'pointerId', 'pointerType', 'relatedTarget'];

export interface DispatchedEvents {
    /** UI events and clicks page scripts dispatched, React's replays left out. A synthetic wake shows up here. */
    synthetic: string[];
    /** React's replays of a native event that reached a target before it hydrated. */
    replayed: string[];
}

/**
 * Records the UI events and clicks page scripts dispatch, from the first frame.
 *
 * Patching dispatchEvent sees only script dispatches, but React DOM is a page
 * script too: a native hover or focus that lands before hydration comes back
 * as React's copy of it. So a window capture listener, which runs before
 * React's, keeps the latest trusted event of each kind React queues. React
 * stops the propagation of every event it queues, so one that bubbles back up
 * to window wasn't queued and is dropped, and so is one whose out event
 * arrives. A dispatch counts as a replay only when it copies a kept event onto
 * its own target, and once. Anything else, a fresh `new MouseEvent('mouseover')`
 * included, counts as synthetic.
 */
export async function recordDispatchedEvents(page: Page): Promise<() => Promise<DispatchedEvents>> {
    await page.addInitScript(({ kinds, copied }) => {
        const record: DispatchedEvents = { synthetic: [], replayed: [] };
        (window as unknown as { __dispatched: DispatchedEvents }).__dispatched = record;

        const pending = new Map<string, Event>();
        (window as unknown as { __queued: () => string[] }).__queued = () => [...pending.values()].map((event) => event.type).sort();
        const key = (type: string, event: Event, byPointer: boolean) =>
            byPointer ? `${type} ${(event as PointerEvent).pointerId}` : type;
        for (const { over, out, byPointer } of kinds) {
            window.addEventListener(over, (event) => {
                if (event.isTrusted) pending.set(key(over, event, byPointer), event);
            }, { capture: true });
            // Back at window, so React didn't stop it, so React didn't queue it.
            window.addEventListener(over, (event) => {
                const id = key(over, event, byPointer);
                if (pending.get(id) === event) pending.delete(id);
            });
            window.addEventListener(out, (event) => {
                if (event.isTrusted) pending.delete(key(over, event, byPointer));
            }, { capture: true });
        }
        const field = (event: Event, name: string) => (event as unknown as Record<string, unknown>)[name];
        // React's copy takes each value as it is. The 1 px allows for a coordinate the init dictionary rounds to a
        // whole number, which would otherwise count a real replay as synthetic.
        const same = (a: unknown, b: unknown) =>
            typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1 : a === b;
        const replayOf = (target: EventTarget, event: Event) => {
            const kind = kinds.find(({ over }) => over === event.type);
            if (!kind || event.isTrusted) return undefined;
            const id = key(event.type, event, kind.byPointer);
            const native = pending.get(id);
            if (!native || native.target !== target || native.constructor !== event.constructor) return undefined;
            if (!copied.every((name) => same(field(native, name), field(event, name)))) return undefined;
            return id;
        };

        const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event: Event) {
            if (event instanceof UIEvent || event.type === 'click') {
                const replay = replayOf(this, event);
                if (replay) {
                    pending.delete(replay);
                    record.replayed.push(event.type);
                } else {
                    record.synthetic.push(event.type);
                }
            }
            return dispatch.call(this, event);
        };
    }, { kinds: REPLAYED, copied: COPIED });
    return () => page.evaluate(() => (window as unknown as { __dispatched: DispatchedEvents }).__dispatched);
}

/**
 * The types of the native events React holds in its queue as the recorder
 * sees them: trusted, stopped before they got back to window, and not yet
 * replayed or cleared by their out event. Needs recordDispatchedEvents first.
 */
export function queuedEvents(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as { __queued: () => string[] }).__queued());
}
