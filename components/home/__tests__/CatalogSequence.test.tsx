import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_HOLD_MS } from '@/components/liveMessage';
import type { HomeImage, HomePhoto } from '@/lib/catalog/projections/home';
import CatalogSequence from '../CatalogSequence';

// The carousel's live region, Home's one announcement (#4): a slide's name and its description are one message. Before
// anything has decoded, as on a first load or on image-unavailable Home, the slide on screen is the one Home moved to,
// whose record may still be on its way, so the line waits for it rather than say the slide twice.

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function image(n: number): HomeImage {
  const file = (width: number, format: string) => ({ url: `/media/${id(n)}/a${n}/p1/w${width}.${format}`, width, height: Math.round((width * 2) / 3), bytes: 1000 + width });
  const ladder = (width: number) => ({ avif: file(width, 'avif'), webp: file(width, 'webp') });
  return { width: 2400, height: 1600, variants: { w400: ladder(400), w800: ladder(800), w1200: ladder(1200), w1920: ladder(1920) } };
}

const photo = (n: number): HomePhoto => ({ id: id(n), alt: `Described photograph ${n}`, focalPoint: { x: 0.5, y: 0.5 }, crop: 'cover', image: image(n) });

/** Series A, 1 and 2, then series B, 3, 4 and 5, as Home's loop plays them. */
const SERIES = [
  { id: 'ser_a', title: 'Series A', photoIds: [id(1), id(2)] },
  { id: 'ser_b', title: 'Series B', photoIds: [id(3), id(4), id(5)] },
];
const ORDER = SERIES.flatMap((series) => series.photoIds);
const seriesOf = (photoId: string) => SERIES.find((series) => series.photoIds.includes(photoId))!;
const slideLabel = (photoId: string) => {
  const { photoIds } = seriesOf(photoId);
  return `${photoIds.indexOf(photoId) + 1} of ${photoIds.length}`;
};
const records = (...ns: number[]) => new Map(ns.map((n) => [id(n), photo(n)] as const));

function sequence({ index, photos, announce = 'polite', recordsFailed = new Set<string>() }: { index: number; photos: ReadonlyMap<string, HomePhoto>; announce?: 'off' | 'polite'; recordsFailed?: ReadonlySet<string> }) {
  return (
    <CatalogSequence
      photoIds={ORDER}
      photos={photos}
      index={index}
      openingId={id(1)}
      playbackState="paused"
      attempts={{}}
      label={seriesOf(ORDER[index]).title}
      slideLabel={slideLabel}
      seriesOf={seriesOf}
      announce={announce}
      recordsFailed={recordsFailed}
      onImageReady={() => undefined}
      onImageFailed={() => undefined}
    />
  );
}

/**
 * Renders the sequence on the opening photograph, nothing decoded, and returns a step that renders the next props and
 * what a screen reader would have heard so far: each new, non-empty line of the polite region, in order.
 */
function home() {
  const view = render(sequence({ index: 0, photos: records(1, 2), announce: 'off' }));
  const heard: string[] = [];
  const step = async (props: Parameters<typeof sequence>[0]) => {
    await act(async () => view.rerender(sequence(props)));
    const region = view.container.querySelector('[aria-live]')!;
    const line = region.textContent ?? '';
    if (region.getAttribute('aria-live') === 'polite' && line !== '' && line !== heard.at(-1)) heard.push(line);
    return heard;
  };
  return { view, step };
}

describe('CatalogSequence: the live region before anything has decoded', () => {
  it('says a move into another series once, with the description, when the record arrives after the move', async () => {
    const { step } = home();
    // The visitor's Next into B, whose first record is still on its way.
    await step({ index: 2, photos: records(1, 2) });
    const heard = await step({ index: 2, photos: records(1, 2, 3) });
    expect(heard).toEqual(['Now showing Series B. 1 of 3, Described photograph 3']);
  });

  it('says a move inside a series once, with the description, when the record arrives after the move', async () => {
    const { step } = home();
    await step({ index: 2, photos: records(1, 2, 3) });
    await step({ index: 3, photos: records(1, 2, 3) });
    const heard = await step({ index: 3, photos: records(1, 2, 3, 4) });
    expect(heard).toEqual(['Now showing Series B. 1 of 3, Described photograph 3', '2 of 3, Described photograph 4']);
  });

  it("still says the move once when the record fails, with the slide's name alone, as it always has", async () => {
    const { step } = home();
    await step({ index: 2, photos: records(1, 2) });
    const heard = await step({ index: 2, photos: records(1, 2), recordsFailed: new Set([id(3)]) });
    expect(heard).toEqual(['Now showing Series B. 1 of 3']);
  });

  it('holds no opening line, even with its record there, from the first render (#246): the slide alone is read', () => {
    const view = render(sequence({ index: 0, photos: records(1, 2), announce: 'off' }));
    expect(view.container.querySelector('[aria-live]')!.textContent).toBe('');
  });
});

// #246: the region holds the line only while it's being announced. A paragraph with text stays in the reading order, so
// a screen reader reading through the carousel would meet the slide twice: the group and its image, then the paragraph.
describe('CatalogSequence: the live region is empty once its line has been said', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const region = (view: ReturnType<typeof render>) => view.container.querySelector('[aria-live]')!;
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('holds nothing while Home plays itself, from the first render on', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 0, photos: records(1, 2, 3), announce: 'off' }));
    expect(region(view).textContent).toBe('');
    view.rerender(sequence({ index: 1, photos: records(1, 2, 3), announce: 'off' }));
    expect(region(view).textContent).toBe('');
    view.rerender(sequence({ index: 2, photos: records(1, 2, 3), announce: 'off' }));
    expect(region(view).textContent).toBe('');
  });

  it('says the visitor\'s own move, keeps it at least a second, then is empty', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 0, photos: records(1, 2, 3), announce: 'off' }));
    view.rerender(sequence({ index: 1, photos: records(1, 2, 3) }));
    expect(region(view)).toHaveAttribute('aria-live', 'polite');
    expect(region(view).textContent).toBe('2 of 2, Described photograph 2');
    advance(1000);
    expect(region(view).textContent).toBe('2 of 2, Described photograph 2');
    advance(9000);
    expect(region(view).textContent).toBe('');
    // Nothing in the carousel reads the slide but the slide.
    expect(view.container.querySelector('p')?.textContent).toBe('');
  });

  it('empties the region LIVE_HOLD_MS after the line lands, the hold the Viewer\'s status keeps too', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 0, photos: records(1, 2, 3), announce: 'off' }));
    view.rerender(sequence({ index: 1, photos: records(1, 2, 3) }));
    advance(LIVE_HOLD_MS - 1);
    expect(region(view).textContent).toBe('2 of 2, Described photograph 2');
    advance(1);
    expect(region(view).textContent).toBe('');
  });

  it('says a crossing as one message, then is empty', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 1, photos: records(1, 2, 3), announce: 'off' }));
    view.rerender(sequence({ index: 2, photos: records(1, 2, 3) }));
    expect(region(view).textContent).toBe('Now showing Series B. 1 of 3, Described photograph 3');
    advance(1000);
    expect(region(view).textContent).toBe('Now showing Series B. 1 of 3, Described photograph 3');
    advance(9000);
    expect(region(view).textContent).toBe('');
  });

  it('says a new move\'s line at once while the last one is still held, and holds the new one from its own landing', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 0, photos: records(1, 2, 3, 4), announce: 'off' }));
    view.rerender(sequence({ index: 2, photos: records(1, 2, 3, 4) }));
    advance(500);
    view.rerender(sequence({ index: 3, photos: records(1, 2, 3, 4) }));
    expect(region(view).textContent).toBe('2 of 3, Described photograph 4');
    advance(1000);
    expect(region(view).textContent).toBe('2 of 3, Described photograph 4');
    advance(9000);
    expect(region(view).textContent).toBe('');
  });

  it('still says a line that comes again while the clear is pending: cleared first, then set, so the change is heard', () => {
    vi.useFakeTimers();
    const view = render(sequence({ index: 0, photos: records(1, 2), announce: 'off' }));
    const heard: string[] = [];
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === 'characterData') heard.push((change.target as Text).data);
        for (const added of change.addedNodes) heard.push(added.textContent ?? '');
      }
    });
    observer.observe(region(view), { childList: true, characterData: true, subtree: true });
    // The visitor's Next into B, then its record goes and comes back while the line is still held.
    view.rerender(sequence({ index: 2, photos: records(1, 2, 3) }));
    advance(300);
    view.rerender(sequence({ index: 2, photos: records(1, 2) }));
    view.rerender(sequence({ index: 2, photos: records(1, 2, 3) }));
    advance(200);
    for (const change of observer.takeRecords()) {
      if (change.type === 'characterData') heard.push((change.target as Text).data);
      for (const added of change.addedNodes) heard.push(added.textContent ?? '');
    }
    observer.disconnect();
    const line = 'Now showing Series B. 1 of 3, Described photograph 3';
    expect(heard.filter((text) => text === line)).toHaveLength(2);
    expect(region(view).textContent).toBe(line);
  });
});
