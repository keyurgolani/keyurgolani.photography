import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from '../themeScript';

const attributeNames = () => document.documentElement.getAttributeNames().sort();

/** Runs the inline script against the test document, and checks it set no attribute but `data-theme`, which each test sets first. */
const run = () => {
  const before = attributeNames();
  try {
    new Function(THEME_INIT_SCRIPT)();
  } finally {
    expect(attributeNames()).toEqual(before);
  }
};

describe('THEME_INIT_SCRIPT', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    for (const name of document.documentElement.getAttributeNames()) document.documentElement.removeAttribute(name);
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  it.each(['light', 'dark'])('applies a stored %s theme', (theme) => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', theme);
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
  });

  it.each([['blue'], ['']])('ignores the stored value %j and keeps the server default', (value) => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', value);
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('keeps the server default with nothing stored', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves no global behind when it runs as a classic script at global scope', () => {
    // A classic inline script's top-level `var` lands on `window`. `new Function` scopes it, so run it in a
    // global context of its own, with the test document's storage and root.
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'light');
    const global = { localStorage, document };
    vm.createContext(global);
    const before = attributeNames();
    vm.runInContext(THEME_INIT_SCRIPT, global);
    expect(attributeNames()).toEqual(before);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(Object.keys(global)).toEqual(['localStorage', 'document']);
  });

  it('keeps the server default when localStorage throws', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(run).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
