import { act, render, screen } from '@testing-library/react';

type DynamicHeroCarouselProps = {
  onFirstImageLoaded?: () => void;
  autoScrollEnabled?: boolean;
};

let latestCarouselProps: DynamicHeroCarouselProps | undefined;

vi.mock('../../components/DynamicHeroCarousel', () => ({
  default: (props: DynamicHeroCarouselProps) => {
    latestCarouselProps = props;
    return <div data-testid="carousel" />;
  },
}));

vi.mock('../../components/HeroReveal', () => ({
  default: ({ isLoading }: { isLoading: boolean }) => (
    <div data-testid="hero-reveal" data-loading={String(isLoading)} />
  ),
}));

vi.mock('../../components/RevealingContents', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/BottomBar', () => ({
  default: () => <div data-testid="bottom-bar" />,
}));

async function loadHome() {
  const module = await import('../page');
  return module.default;
}

describe('Home', () => {
  beforeEach(() => {
    vi.resetModules();
    latestCarouselProps = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays in loading mode until the first carousel image reports ready', async () => {
    const Home = await loadHome();

    render(<Home />);

    expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'true');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'true');

    act(() => {
      latestCarouselProps?.onFirstImageLoaded?.();
    });

    expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'false');
  });

  it('skips loading mode when returning home after the first hero image already loaded', async () => {
    const Home = await loadHome();

    const firstRender = render(<Home />);

    act(() => {
      latestCarouselProps?.onFirstImageLoaded?.();
    });

    expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'false');

    firstRender.unmount();

    render(<Home />);

    expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'false');
    expect(latestCarouselProps?.autoScrollEnabled).toBe(true);
  });
});
