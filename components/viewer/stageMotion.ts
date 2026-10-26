// The Viewer photograph's motion (9a), straight on the DOM, so a frame of a drag never waits on React. The rule (where
// the photograph sits, when it moves, how it settles) is swipe.ts's; this only puts it on screen.
import { PEEK_GAP, settleOf, type SettleKind } from './swipe';
import type { ViewerStep } from './viewerKeys';

/** The strip StoryViewer renders on the stage: the photograph, and the neighbors that peek in beside it. Only it moves. */
export const TRACK_SELECTOR = '[data-viewer-track]';
/** The reading area, whose words change once per move, with a short fade. */
export const READING_SELECTOR = '[data-viewer-reading]';

/** The words fade out over this many ms when a move is decided... */
export const WORDS_OUT = 70;
/** ...and the new photograph's fade in over this many, 200 ms in all. */
export const WORDS_IN = 130;
const WORDS_IN_EASING = 'cubic-bezier(0.25, 1, 0.5, 1)';

const translate = (offset: number) => `translate3d(${offset}px, 0, 0)`;

/** Whether this browser runs the Web Animations the settle needs. jsdom doesn't, and there a settle lands at once. */
const animates = (element: Element) => typeof element.animate === 'function';

interface Running {
    element: HTMLElement;
    animation: Animation | null;
    from: number;
    to: number;
    duration: number;
    easing: string;
    /** The move it settles into, or null for a slide back to rest. */
    step: ViewerStep | null;
}

/**
 * One Viewer's stage motion. It finds the track on every call, since a move by
 * any route renders a new one, and it keeps the settle going across that swap:
 * the new track's photograph is the one that was arriving, so the settle goes
 * on there, moved by one stage, with the same curve and clock (arrive).
 */
export class StageMotion {
    private running: Running | null = null;
    /** Where the drag holds the track, while it does. */
    private held: { element: HTMLElement; offset: number } | null = null;
    /** When the words of the photograph that's leaving began to fade, for the fade in to follow on. */
    private wordsOutAt: number | null = null;

    constructor(private readonly root: HTMLElement) {}

    track(): HTMLElement | null {
        return this.root.querySelector<HTMLElement>(TRACK_SELECTOR);
    }

    /** The stage's width, the photograph's own slot. */
    width(): number {
        return this.track()?.clientWidth ?? 0;
    }

    /** How far the track moves to bring a neighbor in: one slot and the gap. */
    pitch(): number {
        return this.width() + PEEK_GAP;
    }

    /** Whether a settle is under way, onward into a move or back to rest. */
    settling(): boolean {
        return this.running !== null;
    }

    /** Whether a move is settling or settled, and the page that shows it hasn't arrived yet. */
    pendingStep(): ViewerStep | null {
        return this.running?.step ?? null;
    }

    /**
     * Stop the photograph where it is, under a finger that just went down on it mid-settle, and say where that is.
     * A settle into a move isn't caught: that move is decided, and its page is on the way.
     */
    catch(): number {
        const running = this.running;
        if (running === null || running.step !== null) return 0;
        const offset = this.offsetOf(running.element);
        this.stop();
        this.hold(offset);
        return offset;
    }

    /** Hold the track at `offset` from its rest, under the finger. */
    hold(offset: number): void {
        const element = this.track();
        if (element === null) return;
        this.held = { element, offset };
        element.toggleAttribute('data-moving', true);
        element.style.transform = translate(offset);
    }

    /** Where the drag left the track, or 0. */
    heldOffset(): number {
        return this.held?.element.isConnected ? this.held.offset : 0;
    }

    /**
     * Settle from where the drag left the track: onward to the neighbor for `step`, or back to rest for null, with the
     * finger's `velocity` across (CSS px per ms) as the curve's opening speed. Returns the settle's length in ms.
     */
    release(step: ViewerStep | null, velocity: number): number {
        const element = this.held?.element.isConnected ? this.held.element : this.track();
        const from = this.heldOffset();
        this.held = null;
        if (element === null) return 0;
        const to = step === null ? 0 : step === 'next' ? -this.pitch() : this.pitch();
        return this.settle(element, from, to, step, velocity);
    }

    /**
     * The page for a move arrived: its track holds the photograph that was arriving at its rest. A settle into that move
     * goes on on the new track, one stage over, at the same point of the same curve. A move that didn't settle in from
     * a drag (Previous, Next, an arrow key) slides in now from the side it comes from.
     */
    arrive(step: ViewerStep | null): void {
        const element = this.track();
        const running = this.running;
        this.held = null;
        if (element === null) {
            this.stop();
            return;
        }
        if (running !== null && running.step !== null) {
            const shift = running.step === 'next' ? this.pitch() : -this.pitch();
            const time = running.animation?.currentTime ?? null;
            this.stop();
            if (time === null || Number(time) >= running.duration) {
                // It had already landed: the new track is at its rest.
                this.rest(element);
                return;
            }
            this.animate(element, running.from + shift, running.to + shift, null, running.duration, running.easing, Number(time));
            return;
        }
        this.stop();
        if (step === null) {
            this.rest(element);
            return;
        }
        const from = step === 'next' ? this.pitch() : -this.pitch();
        this.settle(element, from, 0, null, 0, 'commit');
    }

    /** Drop any settle or hold and put the track at rest, as Zoom, a pinch, reduced motion, or unmount need. */
    reset(): void {
        this.stop();
        this.held = null;
        const element = this.track();
        if (element !== null) this.rest(element);
    }

    /** Fade the words under the photograph out, once a move is decided. */
    wordsOut(): void {
        const reading = this.root.querySelector(READING_SELECTOR);
        if (reading === null || !animates(reading)) return;
        this.wordsOutAt = performance.now();
        for (const child of reading.children) child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: WORDS_OUT, easing: 'linear', fill: 'forwards' });
    }

    /** Fade the new photograph's words in, after what's left of the fade out, so the change takes 200 ms in all. */
    wordsIn(): void {
        const reading = this.root.querySelector(READING_SELECTOR);
        const outAt = this.wordsOutAt;
        this.wordsOutAt = null;
        if (reading === null || outAt === null || !animates(reading)) return;
        const delay = Math.max(0, WORDS_OUT - (performance.now() - outAt));
        for (const child of reading.children) child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: WORDS_IN, delay, easing: WORDS_IN_EASING, fill: 'backwards' });
    }

    private settle(element: HTMLElement, from: number, to: number, step: ViewerStep | null, velocity: number, kind: SettleKind = step === null ? 'return' : 'commit'): number {
        this.stop();
        const distance = Math.abs(to - from);
        if (distance < 0.5) {
            if (step === null) this.rest(element);
            else this.place(element, to, step);
            return 0;
        }
        // The finger's speed toward where the photograph is going.
        const speed = velocity * Math.sign(to - from);
        const { duration, easing } = settleOf(kind, distance, speed);
        this.animate(element, from, to, step, duration, easing, 0);
        return duration;
    }

    private animate(element: HTMLElement, from: number, to: number, step: ViewerStep | null, duration: number, easing: string, at: number): void {
        if (!animates(element)) {
            if (step === null && to === 0) this.rest(element);
            else this.place(element, to, step);
            return;
        }
        element.toggleAttribute('data-moving', true);
        element.style.transform = translate(to);
        const animation = element.animate([{ transform: translate(from) }, { transform: translate(to) }], { duration, easing, fill: 'backwards' });
        animation.currentTime = at;
        const running: Running = { element, animation, from, to, duration, easing, step };
        this.running = running;
        animation.onfinish = () => {
            if (this.running !== running) return;
            animation.cancel();
            this.running = step === null ? null : { ...running, animation: null };
            if (step === null && to === 0) this.rest(element);
        };
    }

    /** A settle into a move that has landed before its page arrived: the track holds the arriving photograph. */
    private place(element: HTMLElement, to: number, step: ViewerStep | null): void {
        element.toggleAttribute('data-moving', true);
        element.style.transform = translate(to);
        this.running = step === null ? null : { element, animation: null, from: to, to, duration: 0, easing: 'linear', step };
    }

    private rest(element: HTMLElement): void {
        element.style.transform = '';
        element.removeAttribute('data-moving');
    }

    private stop(): void {
        const running = this.running;
        this.running = null;
        if (running?.animation) {
            running.animation.onfinish = null;
            running.animation.cancel();
        }
    }

    private offsetOf(element: HTMLElement): number {
        const transform = getComputedStyle(element).transform;
        if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return 0;
        return new DOMMatrixReadOnly(transform).m41;
    }
}
