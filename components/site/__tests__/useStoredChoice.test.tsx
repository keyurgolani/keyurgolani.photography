import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoredChoice } from '../useStoredChoice';

// The error pages' stand-in for the inline theme script (CI run 41145321923): a page React renders on the client
// from the start never runs that script, so the stored choice has to reach <html> another way.

const html = document.documentElement;

function Page() {
  useStoredChoice();
  return <p>page</p>;
}

/** A device whose colour scheme is light or dark, with the change listener the hook adds. */
function device(light: boolean) {
  const listeners: (() => void)[] = [];
  const query = { matches: light, addEventListener: (_: string, listener: () => void) => listeners.push(listener), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => query);
  return {
    switchTo(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('useStoredChoice', () => {
  beforeEach(() => {
    // What React puts on <html> from the server's props: System, painting Dark.
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
  });

  it.each(['light', 'bright', 'black'])('puts a stored %s on <html> before the page paints', (choice) => {
    device(false);
    localStorage.setItem('theme', choice);
    render(<Page />);
    expect([html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')]).toEqual([choice, choice]);
  });

  it("reads Dark's stored charcoal as Dark, and anything else as System", () => {
    device(true);
    localStorage.setItem('theme', 'charcoal');
    const { unmount } = render(<Page />);
    expect([html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')]).toEqual(['dark', 'dark']);
    unmount();
    localStorage.setItem('theme', 'blue');
    render(<Page />);
    expect([html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')]).toEqual(['system', 'light']);
  });

  it('paints System as the device is set, and follows it when it switches', () => {
    const screen = device(true);
    render(<Page />);
    expect(html.getAttribute('data-theme')).toBe('light');
    screen.switchTo(false);
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('changes nothing where the script already ran', () => {
    device(false);
    localStorage.setItem('theme', 'black');
    html.setAttribute('data-theme', 'black');
    html.setAttribute('data-theme-choice', 'black');
    const observer = new MutationObserver(() => undefined);
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-theme-choice'] });
    render(<Page />);
    const writes = observer.takeRecords().map((record) => record.attributeName);
    observer.disconnect();
    expect(writes).toEqual([]);
  });
});
