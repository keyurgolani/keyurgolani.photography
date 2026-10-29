import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from '../themeScript';

const root = document.documentElement;
const attributeNames = () => root.getAttributeNames().sort();

/** A `prefers-color-scheme: light` query that answers for a light or dark device, and can switch with the page open. */
function device(scheme: 'light' | 'dark') {
  const listeners: Array<() => void> = [];
  const query = {
    matches: scheme === 'light',
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
  };
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

  it.each(['light', 'bright', 'dark', 'black'])('applies a stored %s choice', (choice) => {
    device('dark');
    localStorage.setItem('theme', choice);
    run();
    expect(painted()).toEqual([choice, choice]);
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

  it('keeps an explicit choice when the device switches', () => {
    const media = device('dark');
    localStorage.setItem('theme', 'dark');
    run();
    media.switchTo('light');
    expect(painted()).toEqual(['dark', 'dark']);
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
