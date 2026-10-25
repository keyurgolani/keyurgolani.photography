import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { artist, EXTERNAL_DESTINATION_ICONS, type ExternalDestination } from '@/data/artist';
import ExternalLinks from '../ExternalLinks';

const profile = (id: string, label: string, overrides: Partial<ExternalDestination> = {}): ExternalDestination => ({
  id,
  kind: 'profile',
  label,
  href: `https://example.com/${id}`,
  icon: 'instagram',
  enabled: true,
  ...overrides,
});

const contact: ExternalDestination = { id: 'email', kind: 'contact', label: 'someone@example.com', href: 'mailto:someone@example.com', enabled: true };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labels = () => screen.getAllByRole('link').map((link) => link.textContent);

describe('ExternalLinks', () => {
  it('renders every enabled entry once, in authored order', () => {
    render(<ExternalLinks destinations={[profile('one', 'One'), profile('two', 'Two', { kind: 'repository', icon: 'github' }), profile('three', 'Three')]} />);
    expect(labels()).toEqual(['One', 'Two', 'Three']);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('list')).toHaveAttribute('role', 'list');
  });

  it('leaves out disabled entries and any href that is not https: or mailto:', () => {
    render(
      <ExternalLinks
        destinations={[
          profile('kept', 'Kept'),
          profile('off', 'Off', { enabled: false }),
          profile('script', 'Script', { href: 'javascript:alert(1)' }),
          profile('shouting', 'Shouting', { href: 'JAVASCRIPT:alert(1)' }),
          profile('padded', 'Padded', { href: '  javascript:alert(1)' }),
          profile('plain', 'Plain', { href: 'http://example.com/plain' }),
          profile('relative', 'Relative', { href: '/about' }),
          profile('data', 'Data', { href: 'data:text/html,hi' }),
          contact,
        ]}
      />,
    );
    expect(labels()).toEqual(['Kept', 'someone@example.com']);
  });

  it.each([
    ['every entry is disabled', [profile('one', 'One', { enabled: false }), { ...contact, enabled: false }]],
    ['no entry has a safe href', [profile('script', 'Script', { href: 'javascript:alert(1)' })]],
    ['the list is empty', []],
  ])('renders no nav when %s', (_, destinations) => {
    const { container } = render(<ExternalLinks destinations={destinations} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('names the nav "External profiles" without a contact entry', () => {
    render(<ExternalLinks destinations={[profile('one', 'One'), { ...contact, enabled: false }]} />);
    expect(screen.getByRole('navigation', { name: 'External profiles' })).toBeInTheDocument();
  });

  it('adds "and contact" to the name once a contact entry shows', () => {
    render(<ExternalLinks destinations={[profile('one', 'One'), contact]} />);
    expect(screen.getByRole('navigation', { name: 'External profiles and contact' })).toBeInTheDocument();
  });

  it('opens every link in the same tab, with no title, and a name that starts with its label', () => {
    const destinations = [profile('one', 'One'), profile('two', 'Two', { kind: 'repository', icon: 'github' }), contact];
    render(<ExternalLinks destinations={destinations} />);
    for (const { label, href } of destinations) {
      const link = screen.getByRole('link', { name: new RegExp(`^${escape(label)}`) });
      expect(link).toHaveAttribute('href', href);
      expect(link).not.toHaveAttribute('target');
      expect(link).not.toHaveAttribute('title');
      expect(link).not.toHaveAttribute('aria-label');
    }
  });

  it('hides every icon from assistive technology and gives a contact entry no brand mark', () => {
    const { container } = render(<ExternalLinks destinations={[profile('one', 'One'), contact]} />);
    const svgs = Array.from(container.querySelectorAll('svg'));
    // A brand mark and an arrow on the profile, and only the arrow on the contact.
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('focusable', 'false');
    }
    const [one, email] = screen.getAllByRole('link');
    expect(one.querySelectorAll('svg[data-icon="instagram"]')).toHaveLength(1);
    expect(email.querySelectorAll('svg[data-icon]')).toHaveLength(0);
    expect(email).toHaveTextContent(/^someone@example\.com$/);
  });

  it("names each link's brand for its light, and gives a contact entry none", () => {
    render(<ExternalLinks destinations={[profile('one', 'One'), profile('two', 'Two', { kind: 'repository', icon: 'github' }), contact]} />);
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('data-brand'))).toEqual(['instagram', 'github', null]);
  });

  it('draws one brand mark on each enabled link in the authored data', () => {
    render(<ExternalLinks destinations={artist.destinations} />);
    const enabled = artist.destinations.filter((destination) => destination.enabled);
    const links = within(screen.getByRole('navigation', { name: 'External profiles' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(enabled.map((destination) => destination.label));
    links.forEach((link, index) => {
      const marks = link.querySelectorAll('svg[data-icon]');
      expect(marks).toHaveLength(1);
      expect(marks[0]).toHaveAttribute('data-icon', enabled[index].icon);
    });
  });

  it.each(EXTERNAL_DESTINATION_ICONS)('draws the %s mark from its Simple Icons path', (icon) => {
    const { container } = render(<ExternalLinks destinations={[profile('one', 'One', { icon })]} />);
    const mark = container.querySelector(`svg[data-icon="${icon}"]`);
    const paths = mark?.querySelectorAll('path') ?? [];
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).toMatch(/^M[\d.\s,-]/);
    const [, , width, height] = (mark?.getAttribute('viewBox') ?? '').split(' ').map(Number);
    // 500px's wordmark crops to its band so it can render wide. The rest keep the square grid.
    if (icon === '500px') expect(width / height).toBeGreaterThan(3);
    else expect([width, height]).toEqual([24, 24]);
  });
});
