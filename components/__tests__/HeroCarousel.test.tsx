import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

function renderCarousel(onFirstImageLoaded = vi.fn()) {
  const { container } = render(
    <HeroCarousel
      images={images}
      autoScroll={false}
      autoScrollEnabled={false}
      onFirstImageLoaded={onFirstImageLoaded}
    />
  );
  const layers = (layer: 'thumbnail' | 'optimized') =>
    Array.from(container.querySelectorAll<HTMLImageElement>(`img[data-layer="${layer}"]`));
  return { layers };
}

describe('HeroCarousel', () => {
  it('notifies only after the first optimized image loads', () => {
    const onFirstImageLoaded = vi.fn();
    const { layers } = renderCarousel(onFirstImageLoaded);

    fireEvent.load(layers('thumbnail')[0]);

    expect(onFirstImageLoaded).not.toHaveBeenCalled();

    fireEvent.load(layers('optimized')[0]);

    expect(onFirstImageLoaded).toHaveBeenCalledTimes(1);
  });

  it('names each photo once, on its full-quality layer', () => {
    const { layers } = renderCarousel();

    expect(layers('thumbnail').map((img) => img.getAttribute('alt'))).toEqual(['', '']);
    expect(layers('optimized').map((img) => img.getAttribute('alt'))).toEqual(['Photograph 1 of 2', 'Photograph 2 of 2']);
  });

  it('names the arrows for photographs', () => {
    renderCarousel();

    expect(screen.getByRole('button', { name: 'Previous photograph' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next photograph' })).toBeInTheDocument();
  });
});
