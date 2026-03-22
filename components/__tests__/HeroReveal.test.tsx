import { render } from '@testing-library/react';

vi.mock('../ProfilePicture', () => ({
  default: () => <div data-testid="profile-picture" />,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: (props: Record<string, unknown>) => {
      const domProps = { ...props };
      delete domProps.initial;
      delete domProps.animate;
      delete domProps.transition;
      delete domProps.onAnimationComplete;

      return <div {...domProps}>{props.children as React.ReactNode}</div>;
    },
  },
  useMotionValue: () => ({}),
  useTransform: (_value: unknown, transform: (value: number) => string) => transform(0),
  animate: vi.fn(),
  useAnimationControls: () => ({
    set: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
  }),
}));

async function loadHeroReveal() {
  const module = await import('../HeroReveal');
  return module.default;
}

describe('HeroReveal', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  it('does not render the loading overlay when the hero is already ready on mount', async () => {
    const HeroReveal = await loadHeroReveal();
    const { container } = render(<HeroReveal isLoading={false} onSettled={vi.fn()} />);

    expect(container.querySelector('svg')).toBeNull();
  });
});
