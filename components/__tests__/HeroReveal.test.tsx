import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import HeroReveal from '../HeroReveal';

const framer = vi.hoisted(() => ({
  controls: { set: vi.fn(), start: vi.fn(() => Promise.resolve()), stop: vi.fn() },
  animate: vi.fn(() => ({ stop: vi.fn() })),
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
  useAnimationControls: () => framer.controls,
}));

const settled = () => ({ top: window.innerHeight - 280, left: window.innerWidth / 2, scale: 0.85 });

function renderReveal(isLoading: boolean, onSettled = vi.fn()) {
  const view = render(
    <StrictMode>
      <HeroReveal isLoading={isLoading} onSettled={onSettled} />
    </StrictMode>
  );
  const portrait = () => view.container.querySelector<HTMLElement>('[class*="portrait"]');
  const overlay = () => view.container.querySelector('svg');
  const setLoading = (next: boolean) =>
    view.rerender(
      <StrictMode>
        <HeroReveal isLoading={next} onSettled={onSettled} />
      </StrictMode>
    );
  return { ...view, onSettled, portrait, overlay, setLoading };
}

/** The ripple wait, both reveal steps, and the settle delay. */
const FULL_INTRO_MS = 2400 + 300 + 300 + 50;

describe('HeroReveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    framer.rendered.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not render the loading overlay when the hero is already ready on mount', () => {
    const { overlay } = renderReveal(false);

    expect(overlay()).toBeNull();
  });

  it('a returning visit places the portrait at rest without running the intro', () => {
    renderReveal(false);

    expect(framer.controls.set).toHaveBeenCalledWith(settled());
    expect(framer.animate).not.toHaveBeenCalled();
  });

  it('runs the full intro with motion allowed and reports settled once', async () => {
    const { overlay, onSettled, setLoading } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(framer.controls.set).toHaveBeenCalledWith({ top: window.innerHeight / 2, left: window.innerWidth / 2, scale: 1 });

    setLoading(false);
    await act(() => vi.advanceTimersByTimeAsync(FULL_INTRO_MS));

    expect(framer.animate).toHaveBeenCalledTimes(1);
    expect(framer.controls.start).toHaveBeenCalledWith(expect.objectContaining(settled()));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it('under reduce at mount, mounts no overlay, settles once, and places the portrait before paint', () => {
    setPrefersReducedMotion(true);
    const { overlay, onSettled, portrait } = renderReveal(true);

    expect(overlay()).toBeNull();
    expect(framer.rendered.some((name) => name.includes('grainOverlay'))).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(framer.controls.set).toHaveBeenCalledWith(settled());
    expect(portrait()).toHaveAttribute('data-placed');
  });

  it('under reduce, the portrait takes no pointer, so its tilt stays off', () => {
    setPrefersReducedMotion(true);
    const { portrait } = renderReveal(false);

    expect(portrait()).not.toHaveAttribute('data-pointer');
  });

  it('with motion, the settled portrait takes the pointer until it hides, and again on activity', () => {
    const { portrait } = renderReveal(false);
    expect(portrait()).toHaveAttribute('data-pointer');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(portrait()).not.toHaveAttribute('data-pointer');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown'));
    });
    expect(portrait()).toHaveAttribute('data-pointer');
  });

  it('turning reduce off after settling replays nothing', async () => {
    setPrefersReducedMotion(true);
    const { overlay, onSettled, setLoading } = renderReveal(true);

    act(() => setPrefersReducedMotion(false));
    setLoading(false);
    await act(() => vi.advanceTimersByTimeAsync(FULL_INTRO_MS * 2));

    expect(overlay()).toBeNull();
    expect(framer.animate).not.toHaveBeenCalled();
    expect(framer.controls.start).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reduce turning on while loading settles at once and leaves no timers after unmount', async () => {
    const { overlay, onSettled, portrait, unmount } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => setPrefersReducedMotion(true));

    expect(overlay()).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(framer.progress.set).toHaveBeenCalledWith(1);
    expect(framer.controls.set).toHaveBeenLastCalledWith(settled());
    expect(portrait()).toHaveAttribute('data-placed');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduce turning on mid-reveal stops both animations, and the travel ending later changes nothing', async () => {
    let finishTravel: () => void = () => {};
    framer.controls.start.mockImplementationOnce(() => new Promise<void>((resolve) => (finishTravel = resolve)));
    const { overlay, onSettled, setLoading, unmount } = renderReveal(true);
    setLoading(false);
    await act(() => vi.advanceTimersByTimeAsync(2400 + 300 + 300));
    expect(framer.controls.start).toHaveBeenCalledTimes(1);

    act(() => setPrefersReducedMotion(true));

    const reveal = framer.animate.mock.results[0].value as { stop: ReturnType<typeof vi.fn> };
    expect(reveal.stop).toHaveBeenCalled();
    expect(framer.controls.stop).toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishTravel();
      await vi.advanceTimersByTimeAsync(FULL_INTRO_MS);
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmounting in the moment before settling leaves no timer', async () => {
    const { onSettled, setLoading, unmount } = renderReveal(true);
    setLoading(false);
    // The travel resolves at once here, which arms the short settle delay.
    await act(() => vi.advanceTimersByTimeAsync(2400 + 300 + 300));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('unmounting during the travel arms no settle timer', async () => {
    let finishTravel: () => void = () => {};
    framer.controls.start.mockImplementationOnce(() => new Promise<void>((resolve) => (finishTravel = resolve)));
    const { onSettled, setLoading, unmount } = renderReveal(true);
    setLoading(false);
    await act(() => vi.advanceTimersByTimeAsync(2400 + 300 + 300));

    unmount();
    await act(async () => {
      finishTravel();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
