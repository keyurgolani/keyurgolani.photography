import { render, screen, waitFor } from '@testing-library/react';

type CarouselProps = {
  images: Array<{
    thumbnail: string;
    optimized: string;
    src: string;
  }>;
};

let latestCarouselProps: CarouselProps | undefined;

vi.mock('../HeroCarousel', () => ({
  default: (props: CarouselProps) => {
    latestCarouselProps = props;
    return <div data-testid="hero-carousel" data-count={String(props.images.length)} />;
  },
}));

async function loadDynamicHeroCarousel() {
  const module = await import('../DynamicHeroCarousel');
  return module.default;
}

describe('DynamicHeroCarousel', () => {
  beforeEach(() => {
    vi.resetModules();
    latestCarouselProps = undefined;
  });

  it('reuses the previous carousel images immediately while refreshing in the background', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        {
          thumbnail: '/thumb-1.webp',
          optimized: '/optimized-1.webp',
          src: '/original-1.jpg',
        },
        {
          thumbnail: '/thumb-2.webp',
          optimized: '/optimized-2.webp',
          src: '/original-2.jpg',
        },
      ]),
    } as Response);

    const DynamicHeroCarousel = await loadDynamicHeroCarousel();
    const firstRender = render(<DynamicHeroCarousel />);

    await waitFor(() => {
      expect(screen.getByTestId('hero-carousel')).toHaveAttribute('data-count', '2');
    });

    firstRender.unmount();

    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    render(<DynamicHeroCarousel />);

    expect(screen.getByTestId('hero-carousel')).toHaveAttribute('data-count', '2');
    expect(latestCarouselProps?.images).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
