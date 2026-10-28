import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { artist, type ArtistProfile, type ExternalDestination } from '@/data/artist';
import { VARIANT_WIDTHS } from '@/lib/identity/variants';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import AboutView from '../AboutView';
import { PORTRAIT_SIZES } from '../ArtistPortrait';

const TOKEN = 'a'.repeat(32);
const url = (variant: string) => `/about/portrait/${TOKEN}/${variant}`;

/** A portrait as the page builds it from the host's file and portrait.json. */
const portraitView = (overrides: Partial<AboutPortraitView> = {}): AboutPortraitView => ({
  asset: {
    width: 800,
    height: 1000,
    variants: Object.fromEntries(
      VARIANT_WIDTHS.map((width) => [width, { avif: { url: url(`${width}.avif`), width: Math.min(800, Number(width.slice(1))) }, webp: { url: url(`${width}.webp`), width: Math.min(800, Number(width.slice(1))) } }]),
    ) as AboutPortraitView['asset']['variants'],
  },
  alt: 'Portrait of Test Artist',
  focalPoint: { x: 40, y: 20 },
  ...overrides,
});

const destinations: ExternalDestination[] = [
  { id: 'one', kind: 'profile', label: 'One', href: 'https://example.com/one', icon: 'instagram', enabled: true },
  { id: 'two', kind: 'repository', label: 'Two', href: 'https://example.com/two', icon: 'github', enabled: true },
];

const profile = (overrides: Partial<ArtistProfile> = {}): ArtistProfile => ({
  copyStatus: 'provisional',
  name: 'Test Artist',
  alias: 'TestAlias',
  statementHeading: 'A statement heading.',
  statementParagraphs: ['First paragraph.', 'Second paragraph.'],
  ...overrides,
});

const renderAbout = (overrides: Partial<ArtistProfile> = {}, links = destinations, portrait: AboutPortraitView | null = portraitView()) =>
  render(<AboutView profile={profile(overrides)} portrait={portrait} destinations={links} />);

/** Every element in main that the reading order runs through, in DOM order. */
const readingOrder = () =>
  Array.from(screen.getByRole('main').querySelectorAll('figure, [data-testid="about-portrait"], h1, p, a'))
    .filter((el, index, all) => !all.slice(0, index).some((earlier) => earlier.contains(el)))
    .map((el) => (el.matches('a') ? `link ${el.textContent}` : el.matches('h1') ? 'h1' : el.matches('p') ? `p ${el.textContent}` : 'portrait'));

describe('AboutView', () => {
  it('reads portrait, heading, paragraphs, biography, then the links, in DOM order', () => {
    renderAbout({ shortBiography: 'A short biography.' });
    expect(readingOrder()).toEqual(['portrait', 'h1', 'p First paragraph.', 'p Second paragraph.', 'p A short biography.', 'link One', 'link Two']);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('data-surface', 'about');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A statement heading.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('data-testid', 'about-heading');
  });

  it('gives the portrait its alt, intrinsic size, sizes, and the focal point as object-position', () => {
    renderAbout();
    const figure = screen.getByTestId('about-portrait');
    expect(figure.tagName).toBe('FIGURE');
    const image = within(figure).getByRole('img', { name: 'Portrait of Test Artist' });
    expect(image).toHaveAttribute('width', '800');
    expect(image).toHaveAttribute('height', '1000');
    expect(image.closest('[style]')?.getAttribute('style')).toContain('--portrait-focus: 40% 20%');
    expect(within(figure).getByText('Test Artist', { exact: false }).closest('figcaption')).not.toBeNull();
    expect(figure.querySelector('figcaption')).toHaveTextContent('Test Artist · TestAlias');
  });

  it('loads the portrait from its content-hashed /about/portrait URLs, AVIF then WebP, at the column width', () => {
    renderAbout();
    const figure = screen.getByTestId('about-portrait');
    const sources = Array.from(figure.querySelectorAll('source'));
    expect(sources.map((source) => source.getAttribute('type'))).toEqual(['image/avif', 'image/webp']);
    for (const source of sources) expect(source).toHaveAttribute('sizes', PORTRAIT_SIZES);
    expect(sources[0].getAttribute('srcset')).toBe(`${url('w400.avif')} 400w, ${url('w800.avif')} 800w`);
    expect(within(figure).getByRole('img')).toHaveAttribute('src', url('w1200.webp'));
    expect(within(figure).getByRole('img')).toHaveAttribute('loading', 'eager');
    expect(figure.innerHTML).not.toMatch(/_next\/image|_next\/static|assets\/profile/);
  });

  it('centers the crop on the focal point it is given', () => {
    renderAbout({}, destinations, portraitView({ focalPoint: { x: 50, y: 50 } }));
    expect(screen.getByRole('img').closest('[style]')?.getAttribute('style')).toContain('--portrait-focus: 50% 50%');
  });

  it('with no portrait, shows the name panel in the portrait column, before the heading, with no image', () => {
    renderAbout({}, destinations, null);
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('figcaption')).toBeNull();
    const panel = screen.getByTestId('about-portrait');
    expect(panel).toHaveTextContent('Test Artist · TestAlias');
    expect(readingOrder().slice(0, 2)).toEqual(['portrait', 'h1']);
    // The name shows once.
    expect(screen.getAllByText('Test Artist', { exact: false })).toHaveLength(1);
  });

  it('swaps a failed portrait for the same name panel, with no image or caption left', () => {
    renderAbout();
    fireEvent.error(screen.getByRole('img'));
    const fallback = screen.getByTestId('about-portrait');
    expect(fallback.tagName).not.toBe('FIGURE');
    expect(fallback).toHaveTextContent('Test Artist · TestAlias');
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('figcaption')).toBeNull();
    // The name shows once, and the statement still reads.
    expect(screen.getAllByText('Test Artist', { exact: false })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A statement heading.');
  });

  it('shows the name panel for a portrait that failed before hydration, when no error event reaches React', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const natural = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    try {
      renderAbout();
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByTestId('about-portrait')).toHaveTextContent('Test Artist · TestAlias');
    } finally {
      complete.mockRestore();
      natural.mockRestore();
    }
  });

  it('keeps a portrait that already loaded before hydration', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const natural = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800);
    try {
      renderAbout();
      expect(screen.getByRole('img', { name: 'Portrait of Test Artist' })).toBeInTheDocument();
    } finally {
      complete.mockRestore();
      natural.mockRestore();
    }
  });

  it('renders the same panel for no portrait and a failed one', () => {
    const { container: none, unmount } = renderAbout({}, destinations, null);
    const empty = none.querySelector('[data-testid="about-portrait"]')?.outerHTML;
    unmount();
    renderAbout();
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByTestId('about-portrait').outerHTML).toBe(empty);
  });

  it('leaves the alias out of the name panel when there is none', () => {
    renderAbout({ alias: undefined }, destinations, null);
    expect(screen.getByTestId('about-portrait').textContent).toBe('Test Artist');
  });

  it('leaves the alias out when there is none', () => {
    renderAbout({ alias: undefined });
    expect(document.querySelector('figcaption')?.textContent).toBe('Test Artist');
  });

  it('renders no biography paragraph without one', () => {
    renderAbout();
    expect(readingOrder()).toEqual(['portrait', 'h1', 'p First paragraph.', 'p Second paragraph.', 'link One', 'link Two']);
  });

  it('renders no empty nav with no enabled destinations', () => {
    renderAbout({}, destinations.map((destination) => ({ ...destination, enabled: false })));
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders long copy in full, as text', () => {
    const token = 'x'.repeat(60);
    const heading = `${artist.profile.statementHeading} `.repeat(3).trim();
    const paragraphs = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1} ${token} ${'and more words '.repeat(12)}`.trim());
    renderAbout({ statementHeading: heading, statementParagraphs: paragraphs });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading);
    for (const text of paragraphs) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('renders markup in copy as plain text, never as HTML', () => {
    renderAbout({ statementParagraphs: ['<b>bold</b> & <i>more</i>'] });
    expect(screen.getByText('<b>bold</b> & <i>more</i>')).toBeInTheDocument();
    expect(screen.getByRole('main').querySelector('b, i')).toBeNull();
  });
});
