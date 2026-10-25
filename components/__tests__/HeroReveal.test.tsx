import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import HeroReveal, { type HeroRevealPhase } from '../HeroReveal';
import { HOME_LOADING_TIMEOUT_MS } from '../home/homeChromeConfig';

type AnimateOptions = { duration?: number; onComplete?: () => void };

const framer = vi.hoisted(() => ({
  animate: vi.fn<(value: unknown, to: number, options: AnimateOptions) => { stop: () => void }>(() => ({ stop: vi.fn() })),
  progress: { set: vi.fn() },
  /** The class of every motion.div rendered, so a test can tell the overlay never mounted. */
  rendered: [] as string[],
}));

vi.mock('../ProfilePicture', () => ({
  default: () => <div data-testid="profile-picture" />,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: (props: Record<string, unknown>) => {
      framer.rendered.push(String(props.className ?? ''));
      const domProps = { ...props };
      delete domProps.initial;
      delete domProps.animate;
      delete domProps.transition;
      delete domProps.onAnimationComplete;

      return <div {...domProps}>{props.children as React.ReactNode}</div>;
    },
  },
  // Stable across renders, like the real hooks, so effects don't re-run on every render.
  useMotionValue: () => framer.progress,
  useTransform: (_value: unknown, transform: (value: number) => string) => transform(0),
  animate: framer.animate,
}));

/** The minimum ripple time, then the lead before the mask opens. */
const RIPPLES_MS = 2400;
const LEAD_MS = 300;
/** The mask's duration. */
const MASK_MS = 1200;
/** The exit starts by this long after mount, so the intro ends within Home's 6 s loading bound. */
const EXIT_DEADLINE_MS = HOME_LOADING_TIMEOUT_MS - LEAD_MS - MASK_MS;

function renderReveal(isLoading: boolean) {
  const onSettled = vi.fn();
  const phases: HeroRevealPhase[] = [];
  const onPhaseChange = (phase: HeroRevealPhase) => {
    if (phases.at(-1) !== phase) phases.push(phase);
  };
  const tree = (loading: boolean) => (
    <StrictMode>
      <HeroReveal isLoading={loading} onSettled={onSettled} onPhaseChange={onPhaseChange} />
    </StrictMode>
  );
  const view = render(tree(isLoading));
  const portrait = () => view.container.querySelector<HTMLElement>('[class*="portrait"]');
  const overlay = () => view.container.querySelector('svg');
  const setLoading = (next: boolean) => view.rerender(tree(next));
  /** The mask finishing, as framer-motion reports it. */
  const finishReveal = () =>
    act(() => {
      framer.animate.mock.calls.at(-1)?.[2].onComplete?.();
    });
  return { ...view, onSettled, phases, portrait, overlay, setLoading, finishReveal };
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('HeroReveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    framer.rendered.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a return visit renders nothing and reports settled once', () => {
    const { container, onSettled, phases } = renderReveal(false);
    expect(container).toBeEmptyDOMElement();
    expect(phases).toEqual(['settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(framer.animate).not.toHaveBeenCalled();
  });

  it('a first visit loads over the grain, reveals as the portrait fades, then settles and renders nothing', () => {
    const { container, overlay, portrait, phases, onSettled, setLoading, finishReveal } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(portrait()).not.toHaveAttribute('data-revealing');
    expect(phases).toEqual(['loading']);

    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS - 1);
    expect(phases).toEqual(['loading']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing']);
    expect(portrait()).toHaveAttribute('data-revealing');
    expect(framer.animate).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    finishReveal();
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the ripples run their minimum time from mount, so a slow load reveals at once', () => {
    const { phases, setLoading } = renderReveal(true);
    advance(EXIT_DEADLINE_MS - 1);
    expect(phases).toEqual(['loading']);
    setLoading(false);
    advance(LEAD_MS);
    expect(phases).toEqual(['loading', 'revealing']);
  });

  it('a load that outlasts the deadline still starts the exit by 4500 ms, so the mask ends by 6000 ms', () => {
    const { container, phases, onSettled, setLoading, finishReveal } = renderReveal(true);
    expect(EXIT_DEADLINE_MS).toBe(4500);
    advance(EXIT_DEADLINE_MS + LEAD_MS - 1);
    expect(phases).toEqual(['loading']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing']);
    expect(framer.animate).toHaveBeenCalledTimes(1);
    const { duration } = framer.animate.mock.calls[0][2];
    expect(EXIT_DEADLINE_MS + LEAD_MS + (duration ?? Infinity) * 1000).toBeLessThanOrEqual(HOME_LOADING_TIMEOUT_MS);

    // The intro is gone at 6000 ms on the clock, even with no word from the mask.
    advance(MASK_MS - 1);
    expect(phases).toEqual(['loading', 'revealing']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);

    // Loading ending later, or the mask's own end, changes nothing.
    setLoading(false);
    advance(RIPPLES_MS);
    finishReveal();
    expect(framer.animate).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('loading that ends first still ends the intro early, and clears the deadline', () => {
    const { phases, setLoading } = renderReveal(true);
    advance(1000);
    setLoading(false);
    advance(RIPPLES_MS - 1000 + LEAD_MS);
    expect(phases).toEqual(['loading', 'revealing']);
    // Only the mask's end is left: no deadline starts a second exit.
    expect(vi.getTimerCount()).toBe(1);
    advance(EXIT_DEADLINE_MS);
    expect(framer.animate).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
  });

  it('under reduce at mount renders nothing, mounts no overlay, and settles once', () => {
    setPrefersReducedMotion(true);
    const { container, onSettled, phases } = renderReveal(true);

    expect(container).toBeEmptyDOMElement();
    expect(framer.rendered.some((name) => name.includes('grainOverlay'))).toBe(false);
    expect(phases).toEqual(['settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('turning reduce off after settling replays nothing', () => {
    setPrefersReducedMotion(true);
    const { container, onSettled, setLoading } = renderReveal(true);

    act(() => setPrefersReducedMotion(false));
    setLoading(false);
    advance((RIPPLES_MS + LEAD_MS) * 2);

    expect(container).toBeEmptyDOMElement();
    expect(framer.animate).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reduce turning on while loading settles at once and leaves no timers', () => {
    const { container, overlay, onSettled, phases, unmount } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => setPrefersReducedMotion(true));

    expect(container).toBeEmptyDOMElement();
    expect(phases).toEqual(['loading', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduce turning on mid-reveal stops the mask, and the mask finishing later changes nothing', () => {
    const { container, onSettled, setLoading, finishReveal } = renderReveal(true);
    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS);
    const reveal = framer.animate.mock.results[0].value as { stop: ReturnType<typeof vi.fn> };

    act(() => setPrefersReducedMotion(true));
    expect(reveal.stop).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    expect(onSettled).toHaveBeenCalledTimes(1);

    finishReveal();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('unmounting mid-intro leaves no timer, and the mask finishing after unmount settles nothing', () => {
    const first = renderReveal(true);
    first.setLoading(false);
    advance(RIPPLES_MS);
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);

    const second = renderReveal(true);
    second.setLoading(false);
    advance(RIPPLES_MS + LEAD_MS);
    const reveal = framer.animate.mock.results.at(-1)!.value as { stop: ReturnType<typeof vi.fn> };
    second.unmount();
    expect(reveal.stop).toHaveBeenCalled();
    second.finishReveal();
    expect(second.onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds no window listener, so nothing in the intro watches for activity', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const view = renderReveal(true);
    view.setLoading(false);
    advance(RIPPLES_MS + LEAD_MS);
    view.finishReveal();
    view.unmount();
    renderReveal(false).unmount();
    expect(add).not.toHaveBeenCalled();
  });
});
