import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HomePhoto } from '../homePhoto';
import type { PlaybackState } from '../homePlayback';
import HomeSequence from '../HomeSequence';

const photo = (n: number, total: number): HomePhoto => ({
  id: `/original-${n}.jpg`,
  accessibleName: `Photograph ${n} of ${total}`,
  sources: { thumbnail: `/thumb-${n}.webp`, full: `/optimized-${n}.webp` },
  width: 1200,
  height: 800,
});

const photos = [photo(1, 2), photo(2, 2)];

function renderSequence({
  index = 0,
  playbackState = 'advancing',
  onFirstImageReady = vi.fn(),
  list = photos,
}: { index?: number; playbackState?: PlaybackState; onFirstImageReady?: () => void; list?: HomePhoto[] } = {}) {
  const view = render(
    <HomeSequence photos={list} index={index} playbackState={playbackState} onFirstImageReady={onFirstImageReady} />
  );
  const layers = (layer: 'thumbnail' | 'optimized') =>
    Array.from(view.container.querySelectorAll<HTMLImageElement>(`img[data-layer="${layer}"]`));
  const slides = () => Array.from(view.container.querySelectorAll<HTMLElement>('[aria-hidden]'));
  return { ...view, layers, slides };
}

describe('HomeSequence', () => {
  it('reports ready only after the full-quality layer of the photograph on screen loads', () => {
    const onFirstImageReady = vi.fn();
    const { layers } = renderSequence({ onFirstImageReady });

    fireEvent.load(layers('thumbnail')[0]);
    fireEvent.load(layers('optimized')[1]);
    expect(onFirstImageReady).not.toHaveBeenCalled();

    fireEvent.load(layers('optimized')[0]);
    fireEvent.load(layers('optimized')[0]);
    expect(onFirstImageReady).toHaveBeenCalledTimes(1);
  });

  it('names each photo once, on its full-quality layer', () => {
    const { layers } = renderSequence();

    expect(layers('thumbnail').map((img) => img.getAttribute('alt'))).toEqual(['', '']);
    expect(layers('optimized').map((img) => img.getAttribute('alt'))).toEqual(['Photograph 1 of 2', 'Photograph 2 of 2']);
  });

  it('holds no button or other focusable element, so a slide change has nowhere to send focus', () => {
    const { container } = renderSequence();

    expect(container.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).toHaveLength(0);
  });

  it('shows the slide at index, keyed by id, and hides the rest from assistive tech', () => {
    const { slides, rerender } = renderSequence({ index: 1 });
    expect(slides().map((slide) => slide.getAttribute('aria-hidden'))).toEqual(['true', 'false']);

    // A reordered list keeps each slide with its photo.
    const reordered = [photos[1], photos[0]];
    rerender(<HomeSequence photos={reordered} index={0} playbackState="advancing" />);
    const shown = slides().find((slide) => slide.getAttribute('aria-hidden') === 'false');
    expect(shown?.querySelector('img[data-layer="optimized"]')).toHaveAttribute('alt', 'Photograph 2 of 2');
  });

  it.each([
    ['advancing', 'running'],
    ['paused', 'paused'],
    ['held', 'paused'],
    ['hidden', 'paused'],
    ['reduced-motion', 'paused'],
    ['not-ready', 'paused'],
  ] as const)('runs the slow zoom only while advancing: %s gives %s', (playbackState, zoom) => {
    const { container } = renderSequence({ playbackState });

    expect(container.firstElementChild).toHaveAttribute('data-zoom', zoom);
  });

  it('keeps the zoom on the slide that just left until its fade ends', () => {
    const { slides, rerender } = renderSequence();
    const [first] = slides();
    const zoomClass = Array.from(first.classList).find((name) => name.includes('zoom'));
    expect(zoomClass).toBeDefined();

    rerender(<HomeSequence photos={photos} index={1} playbackState="advancing" />);
    expect(first.classList).toContain(zoomClass);
    expect(slides()[1].classList).toContain(zoomClass);

    fireEvent.transitionEnd(first, { propertyName: 'opacity' });
    expect(first.classList).not.toContain(zoomClass);
    expect(slides()[1].classList).toContain(zoomClass);
  });

  it('renders nothing without photos', () => {
    const { container } = renderSequence({ list: [] });

    expect(container).toBeEmptyDOMElement();
  });
});
