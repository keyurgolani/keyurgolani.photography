import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import BottomBar from '../BottomBar';

type MotionProps = { animate?: Record<string, unknown>; transition?: Record<string, unknown> };

const motionProps = vi.hoisted(() => ({ latest: undefined as MotionProps | undefined }));

vi.mock('framer-motion', () => ({
  motion: {
    div: (props: MotionProps & Record<string, unknown>) => {
      const { animate, transition, children, ...domProps } = props;
      delete domProps.initial;
      motionProps.latest = { animate, transition };
      return <div {...domProps}>{children as React.ReactNode}</div>;
    },
  },
}));

describe('BottomBar', () => {
  it('slides up from below with motion allowed', () => {
    render(<BottomBar visible={false} />);

    expect(motionProps.latest?.animate).toEqual({ y: '100%', opacity: 0 });
    expect(motionProps.latest?.transition).toMatchObject({ duration: 0.8 });
  });

  it('under reduce, appears in place at once, with no travel', () => {
    setPrefersReducedMotion(true);
    const { rerender } = render(<BottomBar visible={false} />);

    expect(motionProps.latest?.animate).toEqual({ y: 0, opacity: 0 });
    expect(motionProps.latest?.transition).toEqual({ duration: 0 });

    rerender(<BottomBar visible />);
    expect(motionProps.latest?.animate).toEqual({ y: 0, opacity: 1 });
    expect(motionProps.latest?.transition).toEqual({ duration: 0 });
  });

  it('follows the preference live', () => {
    render(<BottomBar visible={false} />);
    act(() => setPrefersReducedMotion(true));

    expect(motionProps.latest?.animate).toEqual({ y: 0, opacity: 0 });
    expect(motionProps.latest?.transition).toEqual({ duration: 0 });
  });

  it('scales on hover only with motion allowed', () => {
    render(<BottomBar visible />);

    const pill = screen.getByRole('navigation', { name: 'Primary' }).firstElementChild;
    expect(pill?.className).toContain('motion-safe:hover:scale-[1.02]');
    expect(pill?.className).not.toMatch(/(^|\s)hover:scale/);
  });
});
