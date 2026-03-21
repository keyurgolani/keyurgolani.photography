import { fireEvent, render, screen } from '@testing-library/react';
import HeroCarousel from '../HeroCarousel';

const images = [
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
];

describe('HeroCarousel', () => {
  it('notifies only after the first optimized image loads', () => {
    const onFirstImageLoaded = vi.fn();

    render(
      <HeroCarousel
        images={images}
        autoScroll={false}
        autoScrollEnabled={false}
        onFirstImageLoaded={onFirstImageLoaded}
      />
    );

    const slideOneImages = screen.getAllByAltText('Slide 1');
    const thumbnail = slideOneImages[0];
    const optimized = slideOneImages[1];

    fireEvent.load(thumbnail);

    expect(onFirstImageLoaded).not.toHaveBeenCalled();

    fireEvent.load(optimized);

    expect(onFirstImageLoaded).toHaveBeenCalledTimes(1);
  });
});
