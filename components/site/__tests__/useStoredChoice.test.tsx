import vm from 'node:vm';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSetThemeChoice } from '@/components/ThemeContext';
import { THEME_INIT_SCRIPT } from '../themeScript';
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
  const query = {
    matches: light,
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_: string, listener: () => void) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    switchTo(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

const painted = () => [html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')];

/** Site data blocked: every storage call throws, as Safari's and Firefox's do when cookies are off. */
function blockStorage() {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
}

describe('useStoredChoice', () => {
  beforeEach(() => {
    // What React puts on <html> from the server's props: System, painting Dark.
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    // A new document: the server's System again.
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
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

  it('applies a choice made in another tab', () => {
    device(false);
    render(<Page />);
    localStorage.setItem('theme', 'bright');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'bright' }));
    expect(painted()).toEqual(['bright', 'bright']);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(painted()).toEqual(['system', 'dark']);
  });

  // Review L3″ of #126: with site data blocked, the menu's choice lives only on <html> (setThemeChoice can't store it),
  // so a device change must repaint that choice, not re-read a storage that says System.
  it("keeps the visitor's choice when the device switches and storage is blocked", () => {
    const screen = device(true);
    blockStorage();
    let choose: ReturnType<typeof useSetThemeChoice> = () => undefined;
    function Menu() {
      choose = useSetThemeChoice();
      return null;
    }
    render(
      <>
        <Page />
        <Menu />
      </>,
    );
    expect(painted()).toEqual(['system', 'light']);
    act(() => choose('light'));
    screen.switchTo(false);
    expect(painted()).toEqual(['light', 'light']);
    // And System, picked again, follows the device.
    act(() => choose('system'));
    expect(painted()).toEqual(['system', 'dark']);
    screen.switchTo(true);
    expect(painted()).toEqual(['system', 'light']);
  });

  // #126's errfix review, M1: the error page also mounts into a live document (Home, then a Work that throws), where
  // the script ran and, with storage blocked, the menu's choice lives only on <html>. Mounting must keep it.
  it('keeps a choice made before it mounts, with storage blocked', () => {
    const screen = device(true);
    blockStorage();
    let choose: ReturnType<typeof useSetThemeChoice> = () => undefined;
    function Menu() {
      choose = useSetThemeChoice();
      return null;
    }
    render(<Menu />);
    act(() => choose('light'));
    render(<Page />);
    expect(painted()).toEqual(['light', 'light']);
    screen.switchTo(false);
    expect(painted()).toEqual(['light', 'light']);
  });

  it('stops listening once the page goes', () => {
    const screen = device(true);
    const { unmount } = render(<Page />);
    expect(painted()).toEqual(['system', 'light']);
    unmount();
    screen.switchTo(false);
    localStorage.setItem('theme', 'black');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'black' }));
    expect(painted()).toEqual(['system', 'light']);
  });

  // The hook is the script written again for React, so the two are held to the same answers: each stored value on
  // each device, and after the device switches.
  describe('does what the inline script does', () => {
    const STORED = ['light', 'bright', 'dark', 'black', 'charcoal', 'blue', null, 'throws'] as const;
    const cases = STORED.flatMap((stored) => (['light', 'dark'] as const).map((scheme) => [stored, scheme] as const));

    /** The server's attributes, then what each copy paints at load and once the device has switched. */
    function outcome(stored: (typeof STORED)[number], light: boolean, start: () => (() => void) | void) {
      html.setAttribute('data-theme', 'dark');
      html.setAttribute('data-theme-choice', 'system');
      localStorage.clear();
      if (stored === 'throws') blockStorage();
      else if (stored !== null) localStorage.setItem('theme', stored);
      const screen = device(light);
      const cleanup = start();
      const atLoad = painted();
      screen.switchTo(!light);
      const switched = painted();
      cleanup?.();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      return { atLoad, switched };
    }

    it.each(cases)('stored %j, on a %s device', (stored, scheme) => {
      const light = scheme === 'light';
      // In a global of its own, so its storage listener doesn't outlive the test.
      const script = outcome(stored, light, () => {
        const global: Record<string, unknown> = { localStorage, document, matchMedia: window.matchMedia, addEventListener: () => undefined };
        global.window = global;
        vm.runInContext(THEME_INIT_SCRIPT, vm.createContext(global));
      });
      const hook = outcome(stored, light, () => render(<Page />).unmount);
      expect(hook).toEqual(script);
    });
  });
});
