import { act, render, screen } from '@testing-library/react';
import Home from '../page';

type DynamicHeroCarouselProps = {
  onFirstImageLoaded?: () => void;
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

describe('Home', () => {
  beforeEach(() => {
    latestCarouselProps = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays in loading mode until the first carousel image reports ready', () => {
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
});
