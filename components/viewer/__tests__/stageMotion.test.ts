import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageMotion } from '../stageMotion';
import { PEEK_GAP } from '../swipe';

/** The 390 px stage of an iPhone 13, and the gap a neighbor peeks in behind. */
const WIDTH = 390;
const PITCH = WIDTH + PEEK_GAP;

/**
 * A Web Animation as far as StageMotion uses it. Its clock is its own: StageMotion can read currentTime, but a copy of
 * that reading is only as fine as the browser gives it (whole ms in WebKit), never the clock itself.
 */
interface FakeAnimation {
    currentTime: number;
    onfinish: (() => void) | null;
    cancel: ReturnType<typeof vi.fn>;
    effect: {
        target: Element | null;
        keyframes: Keyframe[];
        setKeyframes(keyframes: Keyframe[]): void;
        getComputedTiming(): { progress: number | null };
    };
}

describe('StageMotion: a swipe\'s settle across its page\'s arrival', () => {
    const made: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: FakeAnimation }[] = [];

    beforeEach(() => {
        made.length = 0;
        Object.assign(Element.prototype, {
            animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
                const animation: FakeAnimation = {
                    currentTime: 0,
                    onfinish: null,
                    cancel: vi.fn(),
                    effect: {
                        target: this,
                        keyframes,
                        setKeyframes(next: Keyframe[]) {
                            this.keyframes = next;
                        },
                        getComputedTiming: () => ({ progress: 0 }),
                    },
                };
                made.push({ target: this, keyframes, options, animation });
                return animation as unknown as Animation;
            },
        });
    });

    afterEach(() => {
        delete (Element.prototype as Partial<Element>).animate;
        document.body.replaceChildren();
    });

    /** A stage with a track of the phone's width, as StoryViewer renders it. */
    const trackIn = (root: HTMLElement) => {
        const track = document.createElement('div');
        track.setAttribute('data-viewer-track', '');
        Object.defineProperty(track, 'clientWidth', { value: WIDTH });
        root.replaceChildren(track);
        return track;
    };

    it('goes on on the new track with the same animation, on its own clock, moved one stage over: never a fresh one from a copy of its time', () => {
        const root = document.createElement('div');
        document.body.append(root);
        const leaving = trackIn(root);
        const motion = new StageMotion(root);
        motion.hold(-120);
        motion.release('next', 0);
        expect(made).toHaveLength(1);
        const [settle] = made;
        expect(settle.target).toBe(leaving);
        expect(settle.keyframes).toEqual([{ transform: 'translate3d(-120px, 0, 0)' }, { transform: `translate3d(${-PITCH}px, 0, 0)` }]);
        // 36 ms in, the page arrives, and the arriving photograph's track replaces the one it was on.
        settle.animation.currentTime = 36;
        const arriving = trackIn(root);
        const landed = vi.fn();
        motion.arrive('next', landed);
        // The same animation, moved to the new track: a new one would start from a copy of the time, rounded to the ms
        // in WebKit, and wait a frame to start, so the photograph would stall a frame or step back up to a ms of travel.
        expect(made).toHaveLength(1);
        expect(settle.animation.cancel).not.toHaveBeenCalled();
        expect(settle.animation.currentTime).toBe(36);
        expect(settle.animation.effect.target).toBe(arriving);
        // On the new track the arriving photograph is the track's own: the same curve, one stage over, to its rest.
        expect(settle.animation.effect.keyframes).toEqual([{ transform: `translate3d(${-120 + PITCH}px, 0, 0)` }, { transform: 'translate3d(0px, 0, 0)' }]);
        expect(arriving.style.transform).toBe('translate3d(0px, 0, 0)');
        expect(arriving).toHaveAttribute('data-moving');
        expect(motion.settling()).toBe(true);
        expect(motion.pendingStep()).toBeNull();
        expect(landed).not.toHaveBeenCalled();
        // It lands at rest on the new track, and says so once.
        settle.animation.onfinish?.();
        expect(landed).toHaveBeenCalledOnce();
        expect(arriving.style.transform).toBe('');
        expect(arriving).not.toHaveAttribute('data-moving');
        expect(motion.settling()).toBe(false);
    });

    it('lands the new track at rest at once when the settle had landed before its page arrived, as before', () => {
        const root = document.createElement('div');
        document.body.append(root);
        trackIn(root);
        const motion = new StageMotion(root);
        motion.hold(-120);
        motion.release('next', 0);
        const [settle] = made;
        settle.animation.onfinish?.();
        expect(motion.pendingStep()).toBe('next');
        const arriving = trackIn(root);
        const landed = vi.fn();
        motion.arrive('next', landed);
        expect(made).toHaveLength(1);
        expect(landed).toHaveBeenCalledOnce();
        expect(arriving.style.transform).toBe('');
        expect(motion.settling()).toBe(false);
    });
});
