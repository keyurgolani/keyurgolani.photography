import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { preloadsIn, serverHtml } from '@/test/helpers/serverHtml';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { V110_LANE } from '@/components/badgePlace';
import type { HomeImage, HomePhoto, PublishedHome } from '@/lib/catalog/projections/home';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
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

/**
 * The useHomeChrome of the module graph CatalogHome is imported into. Each
 * test resets modules, and a mock factory runs once, so beforeEach sets it
 * and the stand-in SiteNav reads it at render time, in Home's context.
 */
const chromeHook = vi.hoisted(() => ({ use: null as null | (() => { hold: (reason: string) => void; release: (reason: string) => void }) }));

// A stand-in SiteNav with a menu that holds the chrome open, as SiteNav's own menu does through useHomeChrome.
vi.mock('@/components/site/SiteNav', () => ({
  default: function SiteNav() {
    const { hold, release } = chromeHook.use!();
    return (
      <nav aria-label="Primary">
        <button type="button" onClick={() => hold('dialog')}>
          Open menu
        </button>
        <button type="button" onClick={() => release('dialog')}>
          Close menu
        </button>
      </nav>
    );
  },
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

/** Series B, which plays after A: 7, 8, 9, opening on 8. */
const ORDER_B = [7, 8, 9];
const SERIES_B = {
  id: 'ser_fixture-b',
  slug: 'fixture-b',
  href: '/work/fixture-b',
  title: 'Fixture series B',
  shortStatement: 'Fixture short statement B.',
  photoIds: ORDER_B.map(id),
  openingPhotoId: id(8),
};

/** A loop of A, then B, with every record from the server unless `photos` says otherwise. */
function looped({ revision = 'a', photos }: { revision?: string; photos?: HomePhoto[] } = {}): PublishedHome {
  const home = published({ revision, photos: photos ?? [...ORDER, ...ORDER_B].map((n) => photo(n)) });
  return { ...home, followingSeries: [SERIES_B] };
}

async function renderHome(home: PublishedHome = published(), { outside = false }: { outside?: boolean } = {}) {
  const { default: CatalogHome } = await import('../CatalogHome');
  const view = render(
    <StrictMode>
      {outside && <button type="button">Outside</button>}
      <CatalogHome home={home} />
    </StrictMode>,
  );
  const rerender = (next: PublishedHome) =>
    view.rerender(
      <StrictMode>
        {outside && <button type="button">Outside</button>}
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
  beforeEach(async () => {
    vi.resetModules();
    // After the reset, so it's the module graph each test then imports CatalogHome into.
    chromeHook.use = (await import('../useHomeChrome')).useHomeChrome;
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
      load(1);
      expect(position()).toBe('02 / 04');
      click('Previous photograph');
      load(4);
      expect(position()).toBe('01 / 04');
      click('Previous photograph');
      load(0);
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

    it('preloads the opening photograph alone in the server HTML, with the srcset and sizes its <picture> has (#6)', async () => {
      const { default: CatalogHome } = await import('../CatalogHome');
      const host = document.createElement('div');
      host.innerHTML = serverHtml(<CatalogHome home={published()} />);
      const links = preloadsIn(host.innerHTML);
      expect(links).toHaveLength(1);
      const avif = host.querySelector(`[data-photo-id="${id(3)}"] source[type="image/avif"]`)!;
      expect(links[0].getAttribute('imagesrcset')).toBe(avif.getAttribute('srcset'));
      // #6's size rule for the viewport-filling slide: the 2400 by 1600 fixture covers it at 150vh wide below 3:2.
      expect(links[0].getAttribute('imagesizes')).toBe('(min-aspect-ratio: 1500/1000) 100vw, 150vh');
      expect(avif.getAttribute('sizes')).toBe(links[0].getAttribute('imagesizes'));
      expect(links[0].getAttribute('type')).toBe('image/avif');
      expect(links[0].hasAttribute('href')).toBe(false);
    });

    it('asks for at most two full-size photographs at first: the opening, then the next once it loads (#6)', async () => {
      const headLinks = document.head.querySelectorAll('link[rel="preload"][as="image"]').length;
      await renderHome();
      const eager = () => [...document.querySelectorAll('[data-photo-id] img')].filter((img) => img.getAttribute('loading') === 'eager');
      expect(eager()).toHaveLength(1);
      load(3);
      expect(eager()).toHaveLength(2);
      // The preload is the server's alone; a client render adds no head link to keep a passed photograph downloading.
      click('Next photograph');
      expect(document.head.querySelectorAll('link[rel="preload"][as="image"]')).toHaveLength(headLinks);
    });

    it('with nothing loaded yet, a move puts the new photograph on screen, since there is nothing to keep', async () => {
      await renderHome();
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(within(shownSlide() as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'Described photograph 0');
      // The opening never showed, so it leaves at once, with nothing to fade, and stops fetching.
      expect(slideImage(3)).toBeNull();
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

    it("yields the badge's lane from 85rem only where Home has the badge, from badgePlace's own constant", async () => {
      const { default: CatalogHome } = await import('../CatalogHome');
      const portrait: AboutPortraitView = {
        asset: { width: 1600, height: 2000, variants: {} as AboutPortraitView['asset']['variants'] },
        alt: 'A stand-in portrait',
        focalPoint: { x: 50, y: 32 },
      };
      const copy = () => document.querySelector('[data-chrome-region="story"] [data-chrome-panel]')!.parentElement!;
      const view = render(<CatalogHome home={published()} portrait={portrait} />);
      expect(copy()).toHaveAttribute('data-badge-lane', '');
      expect(copy().style.getPropertyValue('--badge-lane')).toBe(`${V110_LANE}px`);
      view.unmount();
      render(<CatalogHome home={published()} />);
      expect(copy()).not.toHaveAttribute('data-badge-lane');
      expect(copy().style.getPropertyValue('--badge-lane')).toBe('');
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
      // The next one was mounted, and loads: the move lands.
      load(0);
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
          // Every image failed before hydration: the opening walk tries the next, which failed too.
          expect(holds()).toBe('no-photo');
          expect(failure()).toBe('These photographs can’t be shown right now.');
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
      load(0);
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

    // The controls' own contract, from the legacy Home's HomeView tests, which #13's slice E removed with it.
    it('names the playback button for what it will do, with no aria-pressed', async () => {
      await renderHome();
      load(3);
      const pause = button('Pause slideshow');
      expect(pause).toHaveTextContent('Pause');
      expect(pause).not.toHaveAttribute('aria-pressed');
      expect(pause).toHaveAttribute('type', 'button');

      click('Pause slideshow');
      expect(playback()).toBe('paused');
      const play = button('Play slideshow');
      expect(play).toBe(pause);
      expect(play).toHaveTextContent('Play');
      expect(play).not.toHaveAttribute('aria-pressed');
      click('Play slideshow');
      expect(button('Pause slideshow')).toBe(pause);
      expect(playback()).toBe('advancing');
    });

    it('makes the arrows plain buttons, so they never submit a form around them', async () => {
      await renderHome();
      load(3);
      for (const name of ['Previous photograph', 'Next photograph']) expect(button(name)).toHaveAttribute('type', 'button');
    });

    it('leaves focus outside the chrome where it was across an automatic move', async () => {
      await renderHome(published(), { outside: true });
      load(3);
      const outside = button('Outside');
      act(() => {
        outside.focus();
      });
      advance(HOME_AUTO_ADVANCE_MS);
      load(0);
      expect(position()).toBe('04 / 04');
      expect(document.activeElement).toBe(outside);
    });

    it('a menu holding the chrome open holds the sequence too, and closing it lets both go', async () => {
      await renderHome();
      load(3);
      click('Open menu');
      expect(holds()).toBe('dialog');
      expect(playback()).toBe('held');
      advance(HOME_AUTO_ADVANCE_MS * 2);
      expect(position()).toBe('03 / 04');

      click('Close menu');
      expect(holds()).toBe('');
      expect(playback()).toBe('advancing');
      advance(HOME_AUTO_ADVANCE_MS);
      load(0);
      expect(position()).toBe('04 / 04');
    });

    it('fetches nothing while the opening window plays', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      await renderHome();
      load(3);
      advance(HOME_AUTO_ADVANCE_MS);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('a failed image', () => {
    it('keeps the photograph on screen when the next one fails, and offers Retry and Skip', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      // Until the next one loads, the one before stays on screen, and the position with it.
      expect(position()).toBe('03 / 04');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      fail(0);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(slideImage(3)).toBeInTheDocument();
      expect(failure()).toBe('Couldn’t load photograph 04 of 04');
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
      // Retry stays, with its note, until its photograph lands.
      expect(button('Retry')).toBeInTheDocument();
      // A new element, since a failed image's decode() doesn't fetch again.
      expect(slideImage(0)).not.toBe(failed);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      load(0);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(failure()).toBe('');
      expect(queryButton('Retry')).toBeNull();
    });

    it('Skip moves on in authored order, and a failure stays offered when the visitor comes back to it', async () => {
      await renderHome();
      load(3);
      click('Next photograph');
      fail(0);
      click('Skip');
      load(4);
      expect(position()).toBe('01 / 04');
      expect(failure()).toBe('');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
      click('Previous photograph');
      expect(failure()).toBe('Couldn’t load photograph 04 of 04');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
    });

    it('a walk that gives up ends loading with the chrome held up, and the photograph Retry brings releases it', async () => {
      await renderHome();
      fail(3);
      fail(0);
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      expect(main()).toHaveAttribute('data-interface-state', 'interactive');
      click('Retry');
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
      expect(failure()).toBe('Couldn’t load photograph 04 of 04');
      load(0);
      expect(failure()).toBe('');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
    });

    it('a missing opening set says nothing in the server HTML, since the client walks past it', async () => {
      const { default: CatalogHome } = await import('../CatalogHome');
      const photos = ORDER.map((n) => photo(n, n === 3 ? { image: null } : {}));
      const host = document.createElement('div');
      host.innerHTML = renderToString(<CatalogHome home={published({ photos })} />);
      expect(host.querySelector('[role="status"]')?.textContent).toBe('');
      expect([...host.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Skip');
    });

    it('a missing opening derivative set walks on to the next photograph, which ends loading', async () => {
      const photos = ORDER.map((n) => photo(n, n === 3 ? { image: null } : {}));
      await renderHome(published({ photos }));
      expect(slideImage(3)).toBeNull();
      expect(loading()).toBe('true');
      expect(failure()).toBe('');
      load(0);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      expect(loading()).toBe('false');
      expect(holds()).toBe('');
    });

    it('a missing next derivative never takes the photograph on screen away', async () => {
      const photos = ORDER.map((n) => photo(n, n === 0 ? { image: null } : {}));
      await renderHome(published({ photos }));
      load(3);
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect(failure()).toBe('Couldn’t load photograph 04 of 04');
      expect(button('Skip')).toBeInTheDocument();
      // Nothing to fetch again.
      expect(queryButton('Retry')).toBeNull();
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

  describe('a loop of featured series', () => {
    const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
    const enter = () => screen.getByRole('link', { name: 'Enter the series' }).getAttribute('href');
    const status = () => screen.getByRole('status');
    /** Walks Next `steps` times, loading each photograph Home moves to. */
    const next = (...ns: number[]) => {
      for (const n of ns) {
        click('Next photograph');
        load(n);
      }
    };

    it('opens on the first series with its own chrome, and announces nothing', async () => {
      await renderHome(looped());
      load(3);
      expect([heading(), enter(), position()]).toEqual(['Fixture series A', '/work/fixture-a', '03 / 04']);
      expect(screen.getByText('Fixture short statement A.')).toBeInTheDocument();
      expect(status().textContent).toBe('');
    });

    it('plays the series through, wrapping to the photographs before its opening one, then crosses into the next series\' opening photograph, and the chrome follows', async () => {
      await renderHome(looped());
      load(3);
      next(0, 4, 1);
      expect([heading(), enter(), position()]).toEqual(['Fixture series A', '/work/fixture-a', '02 / 04']);
      next(8);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(8));
      expect([heading(), enter(), position()]).toEqual(['Fixture series B', '/work/fixture-b', '02 / 03']);
      expect(screen.getByText('Fixture short statement B.')).toBeInTheDocument();
      expect(screen.queryByText('Fixture short statement A.')).toBeNull();
      next(9, 7);
      expect([heading(), position()]).toEqual(['Fixture series B', '01 / 03']);
      // After the last series, back to the first one's opening photograph.
      next(3);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      expect([heading(), enter(), position()]).toEqual(['Fixture series A', '/work/fixture-a', '03 / 04']);
    });

    it('announces the new series\' name once in the live region at each crossing, and nothing on a move inside a series', async () => {
      await renderHome(looped());
      load(3);
      const changes: string[] = [];
      const observer = new MutationObserver(() => changes.push(status().textContent ?? ''));
      observer.observe(status(), { subtree: true, childList: true, characterData: true });
      const settle = () => act(async () => await Promise.resolve());
      next(0, 4, 1);
      await settle();
      expect(changes).toEqual([]);
      next(8);
      await settle();
      expect(status()).toHaveTextContent('Now showing Fixture series B');
      next(9, 7);
      await settle();
      expect(changes).toEqual(['Now showing Fixture series B']);
      next(3);
      await settle();
      expect(changes).toEqual(['Now showing Fixture series B', 'Now showing Fixture series A']);
      // The announcement is for assistive technology: the heading already shows the name.
      expect(within(status()).getByText('Now showing Fixture series A')).toHaveClass('sr-only');
      observer.disconnect();
    });

    it('steps back across the boundary with Previous, onto the last photograph the series before plays', async () => {
      await renderHome(looped());
      load(3);
      click('Previous photograph');
      load(7);
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(7));
      expect([heading(), enter(), position()]).toEqual(['Fixture series B', '/work/fixture-b', '01 / 03']);
      expect(status()).toHaveTextContent('Now showing Fixture series B');
      click('Next photograph');
      expect([heading(), position()]).toEqual(['Fixture series A', '03 / 04']);
    });

    it('autoplays across the boundary, a full interval per photograph', async () => {
      await renderHome(looped());
      load(3);
      for (const n of [0, 4, 1]) {
        advance(HOME_AUTO_ADVANCE_MS);
        load(n);
      }
      expect(heading()).toBe('Fixture series A');
      advance(HOME_AUTO_ADVANCE_MS);
      load(8);
      expect([heading(), position()]).toEqual(['Fixture series B', '02 / 03']);
    });

    it('shows the controls for a loop of one-photograph series', async () => {
      const one = published({ order: [3], opening: 3, photos: [photo(3), photo(8)] });
      await renderHome({ ...one, followingSeries: [{ ...SERIES_B, photoIds: [id(8)], openingPhotoId: id(8) }] });
      load(3);
      expect(position()).toBe('01 / 01');
      next(8);
      expect([heading(), position()]).toEqual(['Fixture series B', '01 / 01']);
    });

    it('keeps the chrome on the series of the photograph on screen while the next series\' opening loads, then follows it', async () => {
      await renderHome(looped());
      load(3);
      next(0, 4, 1);
      click('Next photograph');
      // 8 is still loading, so A's last photograph stays up, and so do A's title, statement and link.
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(1));
      expect([heading(), enter()]).toEqual(['Fixture series A', '/work/fixture-a']);
      expect(screen.getByText('Fixture short statement A.')).toBeInTheDocument();
      expect(status().textContent).toBe('');
      // The position stays with the photograph on screen too (#4's commit model).
      expect(position()).toBe('02 / 04');
      load(8);
      expect(position()).toBe('02 / 03');
      expect([heading(), enter()]).toEqual(['Fixture series B', '/work/fixture-b']);
      expect(status()).toHaveTextContent('Now showing Fixture series B');
    });

    it('names the series a failed photograph is in when it isn\'t the one on screen, and announces nothing for it', async () => {
      await renderHome(looped({ photos: [...ORDER.map((n) => photo(n)), photo(7), photo(8, { image: null }), photo(9)] }));
      load(3);
      next(0, 4, 1);
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(1));
      expect(heading()).toBe('Fixture series A');
      expect(status().textContent).toBe('Couldn’t load photograph 02 of 03 in Fixture series B');
      // Skip moves on to 9, which loads: now B is on screen, so the chrome and the announcement follow.
      click('Skip');
      load(9);
      expect(heading()).toBe('Fixture series B');
      expect(status().textContent).toBe('Now showing Fixture series B');
    });

    it('drops the announcement once a failure note shows, so the region reads the note alone', async () => {
      await renderHome(looped({ photos: [...ORDER.map((n) => photo(n)), photo(7), photo(8), photo(9, { image: null })] }));
      load(3);
      next(0, 4, 1, 8);
      expect(status().textContent).toBe('Now showing Fixture series B');
      click('Next photograph');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(8));
      expect(status().textContent).toBe('Couldn’t load photograph 03 of 03');
      // And it doesn't come back when the note goes.
      click('Next photograph');
      load(7);
      expect(status().textContent).toBe('');
    });

    it('starts over on the new pick when the same revision renders again with another series first', async () => {
      const view = await renderHome(looped());
      load(3);
      next(0);
      const { featuredSeries, ...rest } = looped();
      const { records, ...seriesA } = featuredSeries!;
      view.rerender({ ...rest, featuredSeries: { ...SERIES_B, records }, followingSeries: [seriesA] });
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(8));
      expect([heading(), position()]).toEqual(['Fixture series B', '02 / 03']);
      // The new opening photograph is the one the head preloads and the sequence opens on.
      next(9, 7, 3);
      expect(heading()).toBe('Fixture series A');
    });

    it('asks the loop route for the series each window is in, crossing into the next one', async () => {
      const REVISION = `rev_${'a'.repeat(64)}`;
      const href = (series: string, n: number) => `/api/catalog/home/series/${series}/photos/${id(n)}?revision=${REVISION}`;
      const windows: Record<string, number[]> = { [href('ser_fixture-a', 1)]: [0, 1, 2], [href('ser_fixture-a', 2)]: [1, 2, 7], [href('ser_fixture-b', 7)]: [2, 7, 8] };
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({ ok: true, status: 200, json: async () => ({ revisionId: REVISION, photos: (windows[String(url)] ?? []).map((n) => photo(n)) }) }) as unknown as Response);
      const flush = () =>
        act(async () => {
          for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        });
      const home = published({ order: [0, 1, 2], opening: 0, photos: [photo(9), photo(0), photo(1)] });
      await renderHome({ ...home, followingSeries: [{ ...SERIES_B, openingPhotoId: id(7) }] });
      await flush();
      load(0);
      click('Next photograph');
      await flush();
      load(1);
      click('Next photograph');
      await flush();
      const live = fetch.mock.calls.filter(([, init]) => !(init as { signal: AbortSignal }).signal.aborted).map(([url]) => url);
      expect(live).toEqual([href('ser_fixture-a', 1), href('ser_fixture-a', 2), href('ser_fixture-b', 7)]);
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
    const href = (n: number) => `/api/catalog/home/series/ser_fixture-a/photos/${id(n)}?revision=${REVISION}`;
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

    it('a walk past a failed opening asks for no window beyond the photograph it tries, so a dead media route costs one request (#6)', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok([2, 3, 4]));
      await renderHome(narrowed());
      await flush();
      expect(live(fetch)).toEqual([href(3)]);
      fail(2);
      await flush();
      fail(3);
      await flush();
      expect(live(fetch)).toEqual([href(3)]);
    });

    it('keeps the photograph on screen, with no failure, while the next record is on its way', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
      await renderHome(narrowed());
      load(2);
      click('Next photograph');
      load(3);
      click('Next photograph');
      await flush();
      expect(position()).toBe('04 / 06');
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
      expect(failure()).toBe('Couldn’t load photograph 05 of 06');
      expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      fetch.mockImplementation(async () => ok([3, 4, 5]));
      const before = live(fetch).length;
      click('Retry');
      await flush();
      expect(live(fetch).slice(before)).toEqual([href(4)]);
      expect(document.querySelector(`[data-photo-id="${id(4)}"] img`)).not.toBeNull();
      load(4);
      expect(failure()).toBe('');
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
      expect(failure()).toBe('Couldn’t load photograph 05 of 06');
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

  describe('playback, failures, focus and semantics (#4, v2.0.0)', () => {
    const homeState = () => document.querySelector('[data-home-state]')?.getAttribute('data-home-state');
    const live = () => document.querySelector<HTMLElement>('[data-home-carousel] [aria-live]')!;
    const carousel = () => screen.getByRole('region', { name: 'Fixture series A' });
    const focus = (name: string) =>
      act(() => {
        button(name).focus();
      });
    /** Every move Home makes on its own from here, one interval at a time. */
    const tick = () => advance(HOME_AUTO_ADVANCE_MS);
    /** Holds each decode() until the test lets it go, by photograph. jsdom has no decode() of its own. */
    function holdDecodes() {
      const waiting = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
      Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value(this: HTMLImageElement) {
          const photoId = this.closest('[data-photo-id]')!.getAttribute('data-photo-id')!;
          return new Promise<void>((resolve, reject) => waiting.set(photoId, [...(waiting.get(photoId) ?? []), { resolve, reject }]));
        },
      });
      const settle = (n: number, how: 'resolve' | 'reject') =>
        act(async () => {
          for (const entry of waiting.get(id(n)) ?? []) {
            if (how === 'resolve') entry.resolve();
            else entry.reject(new Error('EncodingError'));
          }
          waiting.delete(id(n));
          await Promise.resolve();
        });
      return { resolve: (n: number) => settle(n, 'resolve'), reject: (n: number) => settle(n, 'reject') };
    }

    afterEach(() => {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    });

    describe('the commit model', () => {
      it('commits a slide only once its decode() resolves, not on its load', async () => {
        const decodes = holdDecodes();
        await renderHome();
        load(3);
        // Loaded, not decoded: loading goes on and nothing plays.
        expect(loading()).toBe('true');
        expect(playback()).toBe('not-ready');
        await decodes.resolve(3);
        expect(loading()).toBe('false');
        click('Next photograph');
        load(0);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
        await decodes.resolve(0);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
      });

      it('a decode() that rejects for an image that never loaded is a failure', async () => {
        const decodes = holdDecodes();
        await renderHome();
        load(3);
        await decodes.resolve(3);
        click('Next photograph');
        load(0);
        await decodes.reject(0);
        expect(failure()).toBe('Couldn’t load photograph 04 of 04');
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      });

      it('runs no automatic move while a manual move loads, and gives the commit a full interval', async () => {
        await renderHome();
        load(3);
        advance(HOME_AUTO_ADVANCE_MS - 10);
        click('Next photograph');
        advance(HOME_AUTO_ADVANCE_MS * 3);
        // Still waiting on 0, with 3 on screen: nothing moved on by itself, or 0's load wouldn't bring it on.
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
        load(0);
        advance(HOME_AUTO_ADVANCE_MS - 1);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
        expect(mountedIds()).not.toContain(id(1));
        advance(1);
        load(4);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
      });

      it('the position follows the photograph on screen, not the one on its way', async () => {
        await renderHome();
        load(3);
        click('Next photograph');
        expect(position()).toBe('03 / 04');
        load(0);
        expect(position()).toBe('04 / 04');
      });

      it('mounts only the photograph on screen, the one it moves to, and the one after that, and lets the one before go once it has faded', async () => {
        await renderHome();
        load(3);
        click('Next photograph');
        load(0);
        click('Next photograph');
        load(4);
        // 3 is long gone; 0 is fading out, 4 is on screen, 1 is next.
        expect(new Set(mountedIds())).toEqual(new Set([id(0), id(4), id(1)]));
        act(() => {
          fireEvent.transitionEnd(document.querySelector(`[data-photo-id="${id(0)}"]`)!, { propertyName: 'opacity' });
        });
        expect(new Set(mountedIds())).toEqual(new Set([id(4), id(1)]));
      });
    });

    describe('failures', () => {
      it('an automatic move to a failed photograph skips to the next at once, with no note', async () => {
        await renderHome();
        load(3);
        tick();
        fail(0);
        expect(mountedIds()).toContain(id(4));
        expect(failure()).toBe('');
        expect(queryButton('Skip')).toBeNull();
        load(4);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
        expect(playback()).toBe('advancing');
      });

      it('two automatic failures in a row suspend playback with a polite note, and Play resumes it', async () => {
        await renderHome();
        load(3);
        tick();
        fail(0);
        fail(4);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
        expect(failure()).toBe('Some photographs couldn’t load.');
        expect(screen.getByRole('status')).not.toHaveAttribute('aria-live', 'assertive');
        expect(playback()).toBe('held');
        expect(holds()).toBe('');
        advance(HOME_AUTO_ADVANCE_MS * 3);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
        expect(failure()).toBe('Some photographs couldn’t load.');
        // Suspended, the button offers Play, and Play takes it up again a full interval later.
        click('Play slideshow');
        expect(playback()).toBe('advancing');
        expect(failure()).toBe('');
        advance(HOME_AUTO_ADVANCE_MS);
        load(1);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(1));
      });

      it('a manual move that loads ends the suspension too', async () => {
        await renderHome();
        load(3);
        tick();
        fail(0);
        fail(4);
        click('Next photograph');
        load(1);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(1));
        expect(failure()).toBe('');
        expect(playback()).toBe('advancing');
      });

      it('a success between two failures starts the count over', async () => {
        await renderHome();
        load(3);
        tick();
        fail(0);
        load(4);
        tick();
        fail(1);
        expect(playback()).toBe('advancing');
        expect(failure()).toBe('');
        load(3);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      });

      it('a failed opening walks on to the next photograph inside loading, which then plays from its own position', async () => {
        await renderHome();
        fail(3);
        expect(loading()).toBe('true');
        expect(holds()).toBe('');
        expect(failure()).toBe('');
        expect(queryButton('Skip')).toBeNull();
        load(0);
        expect(loading()).toBe('false');
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
        expect(position()).toBe('04 / 04');
        expect(playback()).toBe('advancing');
        expect(homeState()).toBe('ready');
      });

      it('the opening walk never counts toward the suspension', async () => {
        await renderHome();
        fail(3);
        load(0);
        tick();
        fail(4);
        expect(playback()).toBe('advancing');
        expect(failure()).toBe('');
      });

      it('with the opening and the next both failed, Home says the photographs can\'t be shown, with Retry, and keeps the story', async () => {
        await renderHome();
        fail(3);
        fail(0);
        expect(homeState()).toBe('image-unavailable');
        expect(failure()).toBe('These photographs can’t be shown right now.');
        expect(button('Retry')).toBeInTheDocument();
        expect(queryButton('Skip')).toBeNull();
        expect(queryButton('Next photograph')).toBeNull();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fixture series A');
        expect(screen.getByRole('link', { name: 'Enter the series' })).toBeInTheDocument();
        expect(loading()).toBe('false');
        expect(holds()).toBe('no-photo');
        // At most two photographs asked for: the walk stops instead of asking for the whole loop.
        expect(mountedIds()).toEqual([id(0)]);
        click('Retry');
        load(0);
        expect(homeState()).toBe('ready');
        expect(holds()).toBe('');
        expect(failure()).toBe('');
      });

      it('a one-photograph series that fails can\'t be shown, with Retry alone', async () => {
        await renderHome(published({ order: [3], opening: 3 }));
        fail(3);
        expect(homeState()).toBe('image-unavailable');
        expect(button('Retry')).toBeInTheDocument();
        expect(queryButton('Skip')).toBeNull();
      });

      it('a manual move that fails says which photograph, and keeps Skip in place while Skip\'s own move loads', async () => {
        await renderHome();
        load(3);
        click('Next photograph');
        fail(0);
        expect(failure()).toBe('Couldn’t load photograph 04 of 04');
        click('Skip');
        // Skip's move is on its way: the note and its buttons stay until it lands.
        expect(button('Skip')).toBeInTheDocument();
        load(4);
        expect(queryButton('Skip')).toBeNull();
        expect(failure()).toBe('');
      });

      it('a photograph still loading at #18\'s 6 s bound counts as failed, so a stalled one never stops Home', async () => {
        await renderHome();
        load(3);
        tick();
        advance(HOME_LOADING_TIMEOUT_MS - 1);
        expect(mountedIds()).not.toContain(id(1));
        advance(1);
        // Home's own move: skipped past at once, to 4, whose next is 1.
        expect(mountedIds()).toContain(id(4));
        expect(failure()).toBe('');
        load(4);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(4));
      });

      it('the visitor\'s move still loading at 6 s says so, and a late arrival still lands', async () => {
        await renderHome();
        load(3);
        click('Next photograph');
        advance(HOME_LOADING_TIMEOUT_MS);
        expect(failure()).toBe('Couldn’t load photograph 04 of 04');
        load(0);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(0));
        expect(failure()).toBe('');
      });

      it('the opening has no such bound: a slow opening keeps loading, and nothing walks past it', async () => {
        await renderHome();
        advance(HOME_LOADING_TIMEOUT_MS * 3);
        expect(mountedIds()).toEqual([id(3)]);
        load(3);
        expect(shownSlide()).toHaveAttribute('data-photo-id', id(3));
      });

      it('a failure while paused is offered, never skipped on Home\'s own account', async () => {
        await renderHome();
        load(3);
        tick();
        click('Pause slideshow');
        fail(0);
        expect(failure()).toBe('Couldn’t load photograph 04 of 04');
        expect(button('Skip')).toBeInTheDocument();
      });
    });

    describe('focus', () => {
      it('a focused Skip that succeeds and leaves gives focus back to Next, which started the move', async () => {
        await renderHome();
        load(3);
        focus('Next photograph');
        click('Next photograph');
        fail(0);
        focus('Skip');
        click('Skip');
        expect(document.activeElement).toBe(button('Skip'));
        load(4);
        expect(queryButton('Skip')).toBeNull();
        expect(document.activeElement).toBe(button('Next photograph'));
      });

      it('a focused Retry that succeeds gives focus to Previous when Previous started the move', async () => {
        await renderHome();
        load(3);
        click('Previous photograph');
        fail(1);
        focus('Retry');
        click('Retry');
        load(1);
        expect(document.activeElement).toBe(button('Previous photograph'));
      });

      it('a focused Retry that brings Home back from image-unavailable gives focus to Enter the series', async () => {
        await renderHome();
        fail(3);
        fail(0);
        focus('Retry');
        click('Retry');
        load(0);
        expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Enter the series' }));
      });

      it('leaves focus alone when Retry or Skip wasn\'t focused', async () => {
        await renderHome(published(), { outside: true });
        load(3);
        click('Next photograph');
        fail(0);
        act(() => {
          button('Outside').focus();
        });
        click('Skip');
        load(4);
        expect(document.activeElement).toBe(button('Outside'));
      });
    });

    describe('carousel semantics', () => {
      it('is a carousel region named for the series on screen, with each slide a group named N of M', async () => {
        await renderHome(looped());
        load(3);
        expect(carousel()).toHaveAttribute('aria-roledescription', 'carousel');
        const slide = shownSlide();
        expect(slide).toHaveAttribute('role', 'group');
        expect(slide).toHaveAttribute('aria-roledescription', 'slide');
        expect(slide).toHaveAttribute('aria-label', '3 of 4');
        expect(slide.querySelectorAll('a, button, [tabindex]')).toHaveLength(0);
        for (let step = 0; step < 4; step++) {
          click('Next photograph');
          load([0, 4, 1, 8][step]);
        }
        expect(screen.getByRole('region', { name: 'Fixture series B' })).toBe(document.querySelector('[data-home-carousel]'));
        expect(shownSlide()).toHaveAttribute('aria-label', '2 of 3');
      });

      it('keeps the live region off while it plays by itself, and polite after a manual move, naming the slide and its photograph', async () => {
        await renderHome();
        load(3);
        expect(live()).toHaveAttribute('aria-live', 'off');
        tick();
        load(0);
        expect(live()).toHaveAttribute('aria-live', 'off');
        click('Next photograph');
        expect(live()).toHaveAttribute('aria-live', 'polite');
        load(4);
        expect(live()).toHaveTextContent('1 of 4, Described photograph 4');
        tick();
        expect(live()).toHaveAttribute('aria-live', 'off');
      });

      it('puts the carousel and the first slide\'s name in the server HTML', async () => {
        const { default: CatalogHome } = await import('../CatalogHome');
        const host = document.createElement('div');
        host.innerHTML = renderToString(<CatalogHome home={published()} />);
        const region = host.querySelector('[data-home-carousel]')!;
        expect(region.tagName).toBe('SECTION');
        expect(region).toHaveAttribute('aria-roledescription', 'carousel');
        expect(region).toHaveAttribute('aria-label', 'Fixture series A');
        expect(host.querySelector(`[data-photo-id="${id(3)}"]`)).toHaveAttribute('aria-label', '3 of 4');
      });
    });

    describe('markers', () => {
      it('marks the state and the revision on Home', async () => {
        await renderHome();
        expect(homeState()).toBe('ready');
        expect(main()).toHaveAttribute('data-catalog-revision', `rev_${'a'.repeat(64)}`);
      });

      it('marks the empty state, with the revision', async () => {
        await renderHome(EMPTY);
        expect(homeState()).toBe('empty');
        expect(main()).toHaveAttribute('data-catalog-revision', `rev_${'e'.repeat(64)}`);
      });

      it('puts the markers in the server HTML', async () => {
        const { default: CatalogHome } = await import('../CatalogHome');
        const host = document.createElement('div');
        host.innerHTML = renderToString(<CatalogHome home={published()} />);
        expect(host.querySelector('[data-home-state]')).toHaveAttribute('data-home-state', 'ready');
        expect(host.querySelector('main')).toHaveAttribute('data-catalog-revision', `rev_${'a'.repeat(64)}`);
      });
    });
  });
});
