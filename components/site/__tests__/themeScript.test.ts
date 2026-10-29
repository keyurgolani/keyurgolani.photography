import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from '../themeScript';

const root = document.documentElement;
const attributeNames = () => root.getAttributeNames().sort();

/** A `prefers-color-scheme: light` query that answers for a light or dark device, and can switch with the page open. */
function device(scheme: 'light' | 'dark', { legacy = false }: { legacy?: boolean } = {}) {
  const listeners: Array<() => void> = [];
  const add = (listener: () => void) => listeners.push(listener);
  // Safari 13's MediaQueryList has only the old addListener.
  const query = legacy
    ? { matches: scheme === 'light', addListener: add }
    : { matches: scheme === 'light', addEventListener: (_type: string, listener: () => void) => add(listener) };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    switchTo(next: 'light' | 'dark') {
      query.matches = next === 'light';
      for (const listener of listeners) listener();
    },
  };
}

/** Runs the inline script against the test document, and checks it set no attribute but the two it owns. */
const run = () => {
  try {
    new Function(THEME_INIT_SCRIPT)();
  } finally {
    expect(attributeNames()).toEqual(['data-theme', 'data-theme-choice']);
  }
};

const painted = () => [root.getAttribute('data-theme-choice'), root.getAttribute('data-theme')];

describe('THEME_INIT_SCRIPT', () => {
  beforeEach(() => {
    // What the server sends: System, painting Black (the owner's ruling, 2026-10-28: today's site).
    root.setAttribute('data-theme', 'black');
    root.setAttribute('data-theme-choice', 'system');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    for (const name of root.getAttributeNames()) root.removeAttribute(name);
  });

  it.each(['light', 'bright', 'black'])('applies a stored %s choice', (choice) => {
    device('dark');
    localStorage.setItem('theme', choice);
    run();
    expect(painted()).toEqual([choice, choice]);
  });

  // The lead's ruling on owner question 4 : Dark is stored as `charcoal` and paints `dark`, so the CSS keys
  // on `dark` as before; a stored `dark` is today's toggle, today's look, so it reads as Black.
  it('paints a stored charcoal as Dark', () => {
    device('light');
    localStorage.setItem('theme', 'charcoal');
    run();
    expect(painted()).toEqual(['charcoal', 'dark']);
  });

  it("reads today's stored dark as Black, on a light device too", () => {
    device('light');
    localStorage.setItem('theme', 'dark');
    run();
    expect(painted()).toEqual(['black', 'black']);
  });

  it("keeps today's stored light as Light", () => {
    device('dark');
    localStorage.setItem('theme', 'light');
    run();
    expect(painted()).toEqual(['light', 'light']);
  });

  it('resolves System to Light on a light device and to Black on a dark one', () => {
    device('light');
    localStorage.setItem('theme', 'system');
    run();
    expect(painted()).toEqual(['system', 'light']);
    device('dark');
    run();
    expect(painted()).toEqual(['system', 'black']);
  });

  it('follows the device live while System is chosen', () => {
    const media = device('dark');
    run();
    expect(painted()).toEqual(['system', 'black']);
    media.switchTo('light');
    expect(painted()).toEqual(['system', 'light']);
    media.switchTo('dark');
    expect(painted()).toEqual(['system', 'black']);
  });

  it("follows the device live through Safari 13's addListener", () => {
    const media = device('dark', { legacy: true });
    run();
    media.switchTo('light');
    expect(painted()).toEqual(['system', 'light']);
  });

  it('keeps an explicit choice when the device switches', () => {
    const media = device('dark');
    localStorage.setItem('theme', 'charcoal');
    run();
    media.switchTo('light');
    expect(painted()).toEqual(['charcoal', 'dark']);
  });

  it('applies a choice made in another tab', () => {
    device('dark');
    run();
    expect(painted()).toEqual(['system', 'black']);
    localStorage.setItem('theme', 'bright');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'bright' }));
    expect(painted()).toEqual(['bright', 'bright']);
    localStorage.removeItem('theme');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: null }));
    expect(painted()).toEqual(['system', 'black']);
  });

  it.each([['blue'], [''], ['Dark']])('treats the stored value %j as System', (value) => {
    device('dark');
    localStorage.setItem('theme', value);
    run();
    expect(painted()).toEqual(['system', 'black']);
  });

  it('is System, painting Black, with nothing stored and no matchMedia', () => {
    run();
    expect(painted()).toEqual(['system', 'black']);
  });

  it('is System when localStorage throws', () => {
    device('light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(run).not.toThrow();
    expect(painted()).toEqual(['system', 'light']);
  });

  it('leaves no global behind when it runs as a classic script at global scope', () => {
    // A classic inline script's top-level `var` lands on `window`. `new Function` scopes it, so run it in a
    // global context of its own, with the test document's storage and root.
    localStorage.setItem('theme', 'bright');
    const global: Record<string, unknown> = { localStorage, document, location: { search: '' } };
    global.window = global;
    vm.createContext(global);
    vm.runInContext(THEME_INIT_SCRIPT, global);
    expect(painted()).toEqual(['bright', 'bright']);
    expect(Object.keys(global)).toEqual(['localStorage', 'document', 'location', 'window']);
  });
});
