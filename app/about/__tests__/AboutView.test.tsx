import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { artist, type ArtistProfile, type ExternalDestination } from '@/data/artist';
import AboutView from '../AboutView';
import { PORTRAIT_SIZES } from '../ArtistPortrait';

const SRC = '/assets/profile/front.png';

const destinations: ExternalDestination[] = [
  { id: 'one', kind: 'profile', label: 'One', href: 'https://example.com/one', icon: 'instagram', enabled: true },
  { id: 'two', kind: 'repository', label: 'Two', href: 'https://example.com/two', icon: 'github', enabled: true },
];

const profile = (overrides: Partial<ArtistProfile> = {}): ArtistProfile => ({
  copyStatus: 'provisional',
  name: 'Test Artist',
  alias: 'TestAlias',
  portrait: { width: 800, height: 1000, alt: 'Portrait of Test Artist', focalPoint: { x: 40, y: 20 } },
  statementHeading: 'A statement heading.',
  statementParagraphs: ['First paragraph.', 'Second paragraph.'],
  ...overrides,
});

const renderAbout = (overrides: Partial<ArtistProfile> = {}, links = destinations) => render(<AboutView profile={profile(overrides)} portraitSrc={SRC} destinations={links} />);

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
    expect(image).toHaveAttribute('sizes', PORTRAIT_SIZES);
    expect(image.style.objectPosition).toBe('40% 20%');
    expect(within(figure).getByText('Test Artist', { exact: false }).closest('figcaption')).not.toBeNull();
    expect(figure.querySelector('figcaption')).toHaveTextContent('Test Artist · TestAlias');
  });

  it('centers the crop when the portrait has no focal point', () => {
    renderAbout({ portrait: { width: 800, height: 1000, alt: 'Portrait of Test Artist' } });
    expect(screen.getByRole('img').style.objectPosition).toBe('50% 50%');
  });

  it('shows the name and alias as text before the heading when there is no portrait', () => {
    renderAbout({ portrait: undefined });
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(readingOrder().slice(0, 2)).toEqual(['p Test Artist · TestAlias', 'h1']);
  });

  it('swaps a failed portrait for the name and alias, with no image or caption left', () => {
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
