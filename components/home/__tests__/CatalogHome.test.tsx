import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { HomeImage, HomePhoto, PublishedHome } from '@/lib/catalog/projections/home';
import { HOME_CHROME_IDLE_MS, HOME_LOADING_TIMEOUT_MS } from '../homeChromeConfig';
import { HOME_AUTO_ADVANCE_MS } from '../homePlayback';

// Like the real intro without its timers: loading while Home loads, revealing after, then settled.
vi.mock('@/components/HeroReveal', async () => {
  const { useEffect, useState } = await import('react');
  return {
    default: function HeroReveal({
      isLoading,
      onSettled,
      onPhaseChange,
    }: {
      isLoading: boolean;
      onSettled: () => void;
      onPhaseChange?: (phase: 'loading' | 'revealing' | 'settled') => void;
    }) {
      const [settled, setSettled] = useState(!isLoading);
      useEffect(() => {
        if (!isLoading) setSettled(true);
      }, [isLoading]);
      const phase = settled ? 'settled' : isLoading ? 'loading' : 'revealing';
      useEffect(() => {
        onPhaseChange?.(phase);
      }, [phase, onPhaseChange]);
      useEffect(() => {
        if (settled) onSettled();
      }, [settled, onSettled]);
      return settled ? null : <div data-testid="hero-reveal" data-loading={String(isLoading)} />;
    },
  };
});

vi.mock('@/components/site/SiteNav', () => ({
  default: () => <nav aria-label="Primary" />,
}));

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function image(n: number): HomeImage {
  const file = (width: number, format: string) => ({ url: `/media/${id(n)}/a${n}/p1/w${width}.${format}`, width, height: Math.round((width * 2) / 3), bytes: 1000 + width });
  const ladder = (width: number) => ({ avif: file(width, 'avif'), webp: file(width, 'webp') });
  return { width: 2400, height: 1600, variants: { w400: ladder(400), w800: ladder(800), w1200: ladder(1200), w1920: ladder(1920) } };
}

const photo = (n: number, overrides: Partial<HomePhoto> = {}): HomePhoto => ({
  id: id(n),
  alt: `Described photograph ${n}`,
  focalPoint: { x: 0.5, y: 0.5 },
  image: image(n),
  ...overrides,
});

/** Authored order 4, 1, 3, 0, opening on 3, which neither ID order nor anything else gives. */
const ORDER = [4, 1, 3, 0];

/**
 * A Home with `records` for the given photographs: every one by default, so
 * these tests need no records endpoint. The narrowed tests below pass the
 * server's three.
 */
function published({ order = ORDER, opening = 3, revision = 'a', photos }: { order?: number[]; opening?: number; revision?: string; photos?: HomePhoto[] } = {}): PublishedHome {
  return {
    catalogRevision: `rev_${revision.repeat(64)}`,
    featuredSeries: {
      id: 'ser_fixture-a',
      slug: 'fixture-a',
      href: '/work/fixture-a',
      title: 'Fixture series A',
      shortStatement: 'Fixture short statement A.',
      photoIds: order.map(id),
      records: photos ?? order.map((n) => photo(n)),
      openingPhotoId: id(opening),
    },
  };
}

const EMPTY: PublishedHome = { catalogRevision: `rev_${'e'.repeat(64)}`, featuredSeries: null };

async function renderHome(home: PublishedHome = published()) {
  const { default: CatalogHome } = await import('../CatalogHome');
  const view = render(
    <StrictMode>
      <CatalogHome home={home} />
    </StrictMode>,
  );
  const rerender = (next: PublishedHome) =>
    view.rerender(
      <StrictMode>
        <CatalogHome home={next} />
      </StrictMode>,
    );
  return { ...view, rerender };
}

/** A second Home in the same tab, in the module graph the first one used, so the intro flag carries over. */
async function renderSecondVisit(home: PublishedHome = published()) {
  const { default: CatalogHome } = await import('../CatalogHome');
  return render(
    <StrictMode>
      <CatalogHome home={home} />
    </StrictMode>,
  );
}

const main = () => document.querySelector('main')!;
const loading = () => main().getAttribute('data-home-loading');
const holds = () => main().getAttribute('data-chrome-holds');
const playback = () => document.querySelector('[data-playback]')?.getAttribute('data-playback');
const position = () => screen.getByRole('group', { name: 'Slideshow' }).querySelector('span')?.textContent;
const button = (name: string) => screen.getByRole('button', { name });
const queryButton = (name: string) => screen.queryByRole('button', { name });
/** The slide on screen: the one not hidden from assistive technology. */
const shownSlide = () => {
  const shown = [...document.querySelectorAll('[data-photo-id]')].filter((slide) => slide.getAttribute('aria-hidden') === 'false');
  expect(shown).toHaveLength(1);
  return shown[0];
};
const slideImage = (n: number) => document.querySelector<HTMLImageElement>(`[data-photo-id="${id(n)}"] img`);
const mountedIds = () => [...document.querySelectorAll('[data-photo-id]')].map((slide) => slide.getAttribute('data-photo-id'));
const load = (n: number) =>
  act(() => {
    fireEvent.load(slideImage(n)!);
  });
const fail = (n: number) =>
  act(() => {
    fireEvent.error(slideImage(n)!);
  });
const click = (name: string) =>
  act(() => {
    fireEvent.click(button(name));
  });
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const failure = () => screen.getByRole('status').textContent;

describe('CatalogHome', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the authored sequence', () => {
    it('opens on the authored opening photograph at its authored position', async () => {
      await renderHome();
      expect(position()).toBe('03 / 04');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(within(shownSlide() as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'Described photograph 3');
    });

    it('opens on the first authored photograph when the opening is the first', async () => {
      await renderHome(published({ opening: 4 }));
      expect(position()).toBe('01 / 04');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
    });

    it('moves through the authored order with Previous and Next, wrapping at both ends', async () => {
      await renderHome();
      load(3);
      const seen = [shownSlide().getAttribute('data-photo-id')];
      for (let step = 0; step < 4; step++) {
        click('Next photograph');
        const current = ORDER[(ORDER.indexOf(3) + step + 1) % ORDER.length];
        load(current);
        seen.push(shownSlide().getAttribute('data-photo-id'));
      }
      expect(seen).toEqual([3, 0, 4, 1, 3].map(id));
      click('Previous photograph');
      expect(position()).toBe('02 / 04');
      click('Previous photograph');
      expect(position()).toBe('01 / 04');
      click('Previous photograph');
      expect(position()).toBe('04 / 04');
    });

    it('renders the same opening and order every time for one revision', async () => {
      const first = await renderHome();
      const html = first.container.innerHTML;
      first.unmount();
      const second = await renderHome(structuredClone(published()));
      expect(second.container.innerHTML).toBe(html);
    });

    it('puts the opening photograph in the server HTML, current and named, over its LQIP', async () => {
      const { default: CatalogHome } = await import('../CatalogHome');
      const home = published();
      home.featuredSeries!.records[2].image!.lqip = 'data:image/webp;base64,AAAA';
      const host = document.createElement('div');
      host.innerHTML = renderToString(<CatalogHome home={home} />);
      const slides = [...host.querySelectorAll('[data-photo-id]')];
      expect(slides.map((slide) => slide.getAttribute('data-photo-id'))).toEqual([id(3)]);
      expect(slides[0]).toHaveAttribute('aria-hidden', 'false');
      const img = slides[0].querySelector('img')!;
      expect(img).toHaveAttribute('alt', 'Described photograph 3');
      expect(img).toHaveAttribute('src', `/media/${id(3)}/a3/p1/w1200.webp`);
      expect(img.getAttribute('style')).toContain('data:image/webp;base64,AAAA');
      expect(host.querySelector('source[type="image/avif"]')?.getAttribute('srcset')).toContain(`/media/${id(3)}/a3/p1/w1920.avif 1920w`);
    });

    it('with nothing loaded yet, a move puts the new photograph on screen, since there is nothing to keep', async () => {
      await renderHome();
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(within(shownSlide() as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'Described photograph 0');
      // The opening loading late, off screen, doesn't end loading: the photograph on screen hasn't come.
      load(3);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(loading()).toBe('true');
      load(0);
      expect(loading()).toBe('false');
    });

    it('mounts the next photograph only once one has loaded', async () => {
      await renderHome();
      expect(mountedIds()).toEqual([id(3)]);
      load(3);
      expect(mountedIds()).toEqual([id(3), id(0)]);
    });
  });

  describe('the story', () => {
    it('shows the series title as the heading, its short statement, and Enter the series to its page', async () => {
      await renderHome();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fixture series A');
      expect(screen.getByText('Fixture short statement A.')).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Enter the series' });
      expect(link).toHaveAttribute('href', '/work/fixture-a');
      // The story sits in #18's story region of the chrome.
      expect(link.closest('[data-chrome-region]')).toHaveAttribute('data-chrome-region', 'story');
    });

    it('renders copy as plain text, never as markup', async () => {
      const home = published();
      home.featuredSeries!.title = '<em>Fixture</em> & series';
      home.featuredSeries!.shortStatement = '**not** <b>bold</b>';
      await renderHome(home);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('<em>Fixture</em> & series');
      expect(screen.getByText('**not** <b>bold</b>')).toBeInTheDocument();
      expect(document.querySelector('em, b')).toBeNull();
    });

    it('leaves the statement out when it is blank', async () => {
      const home = published();
      home.featuredSeries!.shortStatement = null;
      await renderHome(home);
      expect(screen.queryByText('Fixture short statement A.')).toBeNull();
      expect(document.querySelector('[data-chrome-region="story"] p')).toBeNull();
      expect(screen.getByRole('link', { name: 'Enter the series' })).toBeInTheDocument();
    });
  });

  describe('loading and playback', () => {
    it('stays loading until the opening photograph loads, then starts immersive and advances a full interval later', async () => {
      await renderHome();
      expect(loading()).toBe('true');
      expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'true');
      expect(playback()).toBe('not-ready');
      advance(5000);
      expect(loading()).toBe('true');
      expect(position()).toBe('03 / 04');

      load(3);
      expect(loading()).toBe('false');
      expect(main()).toHaveAttribute('data-home-intro', 'settled');
      expect(main()).toHaveAttribute('data-interface-state', 'immersive');
      expect(holds()).toBe('');
      expect(playback()).toBe('advancing');
      advance(HOME_AUTO_ADVANCE_MS - 1);
      expect(position()).toBe('03 / 04');
      advance(1);
      expect(position()).toBe('04 / 04');
    });

    it('a return visit skips loading and the intro, and the sequence still waits for the photograph', async () => {
      const first = await renderHome();
      load(3);
      first.unmount();
      const second = await renderSecondVisit();
      expect(loading()).toBe('false');
      expect(screen.queryByTestId('hero-reveal')).toBeNull();
      expect(playback()).toBe('not-ready');
      advance(HOME_AUTO_ADVANCE_MS * 2);
      expect(position()).toBe('03 / 04');
      load(3);
      expect(playback()).toBe('advancing');
      second.unmount();
    });

    it('a stalled opening ends loading at #18\'s bound, with the chrome held up', async () => {
      await renderHome();
      advance(HOME_LOADING_TIMEOUT_MS);
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      load(3);
      expect(holds()).toBe('');
    });

    for (const [settled, naturalWidth] of [['loaded', 2400], ['failed', 0]] as const) {
      it(`counts an image that ${settled} before hydration, which fires no event`, async () => {
        vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(naturalWidth);
        await renderHome();
        expect(loading()).toBe('false');
        if (naturalWidth > 0) {
          expect(holds()).toBe('');
          expect(screen.getByRole('status').textContent).toBe('');
        } else {
          expect(holds()).toBe('no-photo');
          expect(failure()).toBe('Photograph 03 of 04 couldn’t load.');
        }
      });
    }

    it('Pause stops the authored sequence, and Play starts it a full interval later', async () => {
      await renderHome();
      load(3);
      click('Pause slideshow');
      expect(playback()).toBe('paused');
      advance(HOME_AUTO_ADVANCE_MS * 3);
      expect(position()).toBe('03 / 04');
      click('Play slideshow');
      advance(HOME_AUTO_ADVANCE_MS);
      expect(position()).toBe('04 / 04');
    });

    it('keyboard focus in the chrome holds the sequence, through the shared holds', async () => {
      await renderHome();
      load(3);
      const link = screen.getByRole('link', { name: 'Enter the series' });
      // Keyboard focus, the way a browser reports it.
      const matches = link.matches.bind(link);
      vi.spyOn(link, 'matches').mockImplementation((selector: string) => selector === ':focus-visible' || matches(selector));
      act(() => {
        link.focus();
      });
      expect(playback()).toBe('held');
      expect(holds()).toContain('keyboard-focus');
      advance(HOME_AUTO_ADVANCE_MS * 2);
      expect(position()).toBe('03 / 04');
    });

    it('a mouse resting on the slideshow controls holds the sequence while the chrome shows them', async () => {
      await renderHome();
      load(3);
      // A real mouse move over Home, which is what reveals the chrome.
      act(() => {
        for (const clientX of [0, 1]) {
          main().dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', isPrimary: true, clientX, clientY: 200, movementX: 1, bubbles: true }));
        }
      });
      expect(main()).toHaveAttribute('data-interface-state', 'interactive');
      expect(playback()).toBe('advancing');

      const group = screen.getByRole('group', { name: 'Slideshow' });
      fireEvent.pointerEnter(group, { pointerType: 'mouse' });
      expect(playback()).toBe('held');
      advance(HOME_AUTO_ADVANCE_MS / 4);
      expect(position()).toBe('03 / 04');
      fireEvent.pointerLeave(group, { pointerType: 'mouse' });
      expect(playback()).toBe('advancing');
    });

    it('never reads the legacy photo list or /api/photos', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const cache = await import('@/utils/homeHeroCache');
      cache.setCachedHomeHeroImages([{ id: '/legacy.jpg', accessibleName: 'Legacy', sources: { thumbnail: '/legacy-thumb.webp', full: '/legacy.webp' }, width: 1, height: 1 }]);
      const get = vi.spyOn(cache, 'getCachedHomeHeroImages');
      await renderHome();
      load(3);
      advance(HOME_AUTO_ADVANCE_MS);
      expect(document.body.innerHTML).not.toContain('legacy');
      expect(get).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('a failed image', () => {
    it('keeps the photograph on screen when the next one fails, and offers Retry and Skip', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      expect(position()).toBe('04 / 04');
      // Until the next one loads, the one before stays on screen.
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      fail(0);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(slideImage(3)).toBeInTheDocument();
      expect(failure()).toBe('Photograph 04 of 04 couldn’t load.');
      expect(button('Retry')).toBeInTheDocument();
      expect(button('Skip')).toBeInTheDocument();
      expect(loading()).toBe('false');
      expect(holds()).toBe('');
    });

    it('Retry fetches the failed image again, and its load brings it on screen', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      fail(0);
      const failed = slideImage(0);
      click('Retry');
      expect(failure()).toBe('');
      expect(queryButton('Retry')).toBeNull();
      // A new element, since a failed image's decode() doesn't fetch again.
      expect(slideImage(0)).not.toBe(failed);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      load(0);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
    });

    it('Skip moves on in authored order, and a failure stays offered when the visitor comes back to it', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      fail(0);
      click('Skip');
      expect(position()).toBe('01 / 04');
      expect(failure()).toBe('');
      load(4);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
      click('Previous photograph');
      expect(failure()).toBe('Photograph 04 of 04 couldn’t load.');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
    });

    it('a failed opening ends loading with the chrome held up, and the next photograph that loads releases it', async () => {
      await renderHome();
      fail(3);
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      expect(main()).toHaveAttribute('data-interface-state', 'interactive');
      expect(failure()).toBe('Photograph 03 of 04 couldn’t load.');
      click('Skip');
      load(0);
      expect(holds()).toBe('');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(playback()).toBe('advancing');
    });

    it('a load after an error, with no Retry, clears the failure', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      fail(0);
      expect(failure()).toBe('Photograph 04 of 04 couldn’t load.');
      load(0);
      expect(failure()).toBe('');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
    });

    it('a missing opening set is already offered in the server HTML', async () => {
      const { default: CatalogHome } = await import('../CatalogHome');
      const photos = ORDER.map((n) => photo(n, n === 3 ? { image: null } : {}));
      const host = document.createElement('div');
      host.innerHTML = renderToString(<CatalogHome home={published({ photos })} />);
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Photograph 03 of 04 couldn’t load.');
      expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toContain('Skip');
    });

    it('a missing derivative set shows the missing image with Skip, and no Retry', async () => {
      const photos = ORDER.map((n) => photo(n, n === 3 ? { image: null } : {}));
      await renderHome(published({ photos }));
      expect(slideImage(3)).toBeNull();
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      expect(failure()).toBe('Photograph 03 of 04 couldn’t load.');
      expect(queryButton('Retry')).toBeNull();
      click('Skip');
      load(0);
      expect(holds()).toBe('');
    });

    it('a missing next derivative never takes the photograph on screen away', async () => {
      const photos = ORDER.map((n) => photo(n, n === 0 ? { image: null } : {}));
      await renderHome(published({ photos }));
      load(3);
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(failure()).toBe('Photograph 04 of 04 couldn’t load.');
      expect(button('Skip')).toBeInTheDocument();
    });

    it('a one-photograph series that fails offers Retry alone', async () => {
      await renderHome(published({ order: [3], opening: 3 }));
      fail(3);
      expect(button('Retry')).toBeInTheDocument();
      expect(queryButton('Skip')).toBeNull();
    });
  });

  describe('catalog revisions', () => {
    it('a new revision replaces the sequence at once, on its own opening, with nothing from the old one', async () => {
      const view = await renderHome();
      load(3);
      click('Next photograph');
      load(0);
      view.rerender(published({ revision: 'b', order: [7, 5, 6], opening: 6 }));
      expect(position()).toBe('03 / 03');
      expect(mountedIds()).toEqual([id(6)]);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(6));
      expect(screen.getAllByRole('img', { hidden: true }).every((img) => img.getAttribute('src')!.includes(id(6)))).toBe(true);
    });

    it('the same revision rendered again keeps the photograph on screen', async () => {
      const view = await renderHome();
      load(3);
      click('Next photograph');
      load(0);
      view.rerender(structuredClone(published()));
      expect(position()).toBe('04 / 04');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
    });
  });

  describe('the empty state', () => {
    it('shows the navigation and a heading, with no intro, no photograph, and the chrome held up', async () => {
      await renderHome(EMPTY);
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nothing is featured right now.');
      expect(screen.queryByTestId('hero-reveal')).toBeNull();
      expect(document.querySelector('img')).toBeNull();
      expect(loading()).toBe('false');
      expect(main()).toHaveAttribute('data-home-intro', 'settled');
      expect(holds()).toBe('no-photo');
      expect(main()).toHaveAttribute('data-interface-state', 'interactive');
      advance(HOME_CHROME_IDLE_MS * 3);
      expect(main()).toHaveAttribute('data-interface-state', 'interactive');
      expect(queryButton('Next photograph')).toBeNull();
    });
  });

  describe('the narrowed Home (#6): three records from the server, the rest as Home moves', () => {
    /** Six photographs in ID order, opening on 2, with the server's window: 1, 2, and 3. */
    const SIX = [0, 1, 2, 3, 4, 5];
    const narrowed = (revision = 'a') => published({ order: SIX, opening: 2, revision, photos: [photo(1), photo(2), photo(3)] });
    const REVISION = `rev_${'a'.repeat(64)}`;
    const href = (n: number) => `/api/catalog/home/photos/${id(n)}?revision=${REVISION}`;
    type Init = { signal: AbortSignal };
    const ok = (ns: number[], revisionId = REVISION) => ({ ok: true, status: 200, json: async () => ({ revisionId, photos: ns.map((n) => photo(n)) }) }) as unknown as Response;
    const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;
    /** Calls a live component made: React's development remount aborts the first one. */
    const live = (fetch: MockInstance<typeof globalThis.fetch>) => fetch.mock.calls.filter(([, init]) => !(init as Init).signal.aborted).map(([url]) => url);
    const flush = () =>
      act(async () => {
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      });

    beforeEach(() => {
      router.refresh.mockClear();
    });

    it('asks for the next window one step ahead, bound to the rendered revision, and never twice', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url) === href(3) ? ok([2, 3, 4]) : ok([3, 4, 5])));
      await renderHome(narrowed());
      await flush();
      // The window around 3 brings 4, the photograph after next.
      expect(live(fetch)).toEqual([href(3)]);
      load(2);
      click('Next photograph');
      await flush();
      expect(live(fetch)).toEqual([href(3), href(4)]);
      load(3);
      click('Next photograph');
      await flush();
      expect(new Set(live(fetch)).size).toBe(live(fetch).length);
      expect(document.querySelector(`[data-photo-id="${id(4)}"] img`)).not.toBeNull();
    });

    it('keeps the photograph on screen, with no failure, while the next record is on its way', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
      await renderHome(narrowed());
      load(2);
      click('Next photograph');
      load(3);
      click('Next photograph');
      await flush();
      expect(position()).toBe('05 / 06');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(failure()).toBe('');
      expect(queryButton('Retry')).toBeNull();
    });

    it('shows a record that couldn\'t be fetched as failed, with Retry asking again', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => status(503));
      await renderHome(narrowed());
      await flush();
      load(2);
      click('Next photograph');
      load(3);
      click('Next photograph');
      await flush();
      expect(failure()).toBe('Photograph 05 of 06 couldn’t load.');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      fetch.mockImplementation(async () => ok([3, 4, 5]));
      const before = live(fetch).length;
      click('Retry');
      await flush();
      expect(live(fetch).slice(before)).toEqual([href(4)]);
      expect(failure()).toBe('');
      expect(document.querySelector(`[data-photo-id="${id(4)}"] img`)).not.toBeNull();
    });

    it('ignores records from another revision, so two revisions never mix', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok([2, 3, 4], `rev_${'b'.repeat(64)}`));
      await renderHome(narrowed());
      await flush();
      load(2);
      click('Next photograph');
      load(3);
      click('Next photograph');
      await flush();
      expect(document.querySelector(`[data-photo-id="${id(4)}"] img`)).toBeNull();
      expect(failure()).toBe('Photograph 05 of 06 couldn’t load.');
    });

    it('re-renders from the new revision once on a 409, however many requests get one', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => status(409));
      await renderHome(narrowed());
      await flush();
      load(2);
      click('Next photograph');
      await flush();
      click('Next photograph');
      await flush();
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect(failure()).toBe('');
    });

    it('starts over on the new revision\'s records when the refresh brings one, with nothing from the old', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok([2, 3, 4]));
      const view = await renderHome(narrowed());
      await flush();
      view.rerender(narrowed('b'));
      expect(position()).toBe('03 / 06');
      // The new Home holds only its own server window until it asks the new revision.
      expect(document.querySelector(`[data-photo-id="${id(4)}"] img`)).toBeNull();
    });

    it('aborts what it asked for when Home unmounts', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
      const view = await renderHome(narrowed());
      await flush();
      const signals = fetch.mock.calls.map(([, init]) => (init as Init).signal);
      expect(signals.some((signal) => !signal.aborted)).toBe(true);
      view.unmount();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
  });
});
