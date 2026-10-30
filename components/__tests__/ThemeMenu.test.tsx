import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The popover's styles stand in as a component that hands its onReady to the test, so the test decides when they land.
const styles = vi.hoisted(() => ({ ready: null as null | (() => void), mounted: 0 }));
vi.mock('next/dynamic', () => ({
  default: () =>
    function PopoverStyles({ onReady }: { onReady: () => void }) {
      styles.mounted++;
      styles.ready = onReady;
      return null;
    },
}));

const setChoice = vi.hoisted(() => vi.fn());
vi.mock('../ThemeContext', () => ({
  useThemeChoice: () => ({ choice: 'system', theme: 'dark', setChoice }),
}));

import ThemeMenu from '../ThemeMenu';

const button = () => screen.getByRole('button', { name: /^Theme:/ });
const radio = (name: RegExp) => screen.getByRole('radio', { name, hidden: true });
const nextTask = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

let showPopover: ReturnType<typeof vi.fn>;

beforeEach(() => {
  styles.ready = null;
  styles.mounted = 0;
  setChoice.mockClear();
  showPopover = vi.fn();
  // jsdom has no popover API.
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: showPopover, configurable: true });
});

afterEach(() => {
  delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover;
});

describe('ThemeMenu', () => {
  it('renders every name and both "now" notes on the server, for CSS to pick from before React runs', () => {
    const html = renderToString(<ThemeMenu />);
    for (const name of ['System', 'Light', 'Bright', 'Dark', 'Black']) expect(html).toContain(`>${name}</span>`);
    expect(html).toContain('data-now="light"');
    expect(html).toContain('data-now="dark"');
    expect(html).toContain('data-theme-control=""');
    // No popovertarget until the styles are in, so the popover never opens unstyled.
    expect(html).not.toContain('popovertarget');
  });

  it('holds a press made before the styles land, marked busy, and opens the menu once they do (R2-P3-3)', async () => {
    render(<ThemeMenu />);
    expect(button()).not.toHaveAttribute('popovertarget');
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(styles.ready).not.toBeNull();
    expect(showPopover).not.toHaveBeenCalled();
    await act(async () => styles.ready!());
    expect(showPopover).toHaveBeenCalledTimes(1);
    expect(button()).not.toHaveAttribute('aria-busy');
    expect(button()).toHaveAttribute('popovertarget');
  });

  it('loads the styles when the pointer or focus reaches the button, and opens natively once they are in', async () => {
    render(<ThemeMenu />);
    fireEvent.focus(button());
    expect(styles.mounted).toBeGreaterThan(0);
    await act(async () => styles.ready!());
    expect(button()).toHaveAttribute('popovertarget');
    fireEvent.click(button());
    // The native popovertarget opens it; nothing waits, so nothing is marked busy.
    expect(button()).not.toHaveAttribute('aria-busy');
    expect(showPopover).not.toHaveBeenCalled();
  });

  it("crossfades a pointer's choice and not a keyboard's (P3-12)", async () => {
    render(<ThemeMenu />);
    const group = screen.getByRole('group', { name: 'Theme', hidden: true });
    fireEvent.pointerDown(group);
    fireEvent.click(radio(/^Light/));
    expect(setChoice).toHaveBeenLastCalledWith('light', { animate: true });
    fireEvent.pointerUp(window);
    await nextTask();
    // An arrow key changes the radio with no press.
    fireEvent.click(radio(/^Bright/));
    expect(setChoice).toHaveBeenLastCalledWith('bright', { animate: false });
  });

  it('leaves no listener behind once a press is over (D6)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(<ThemeMenu />);
    const group = screen.getByRole('group', { name: 'Theme', hidden: true });
    fireEvent.pointerDown(group);
    const signals = add.mock.calls.filter(([type]) => type === 'pointerup' || type === 'pointercancel').map(([, , options]) => (options as AddEventListenerOptions).signal);
    expect(signals).toHaveLength(2);
    fireEvent.pointerUp(window);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    add.mockRestore();
  });

  it('forgets a press that chose nothing, so the next arrow key does not crossfade (L1)', async () => {
    render(<ThemeMenu />);
    const group = screen.getByRole('group', { name: 'Theme', hidden: true });
    // A press on the legend, or a drag off a row: no change.
    fireEvent.pointerDown(group);
    fireEvent.pointerUp(window);
    await nextTask();
    fireEvent.click(radio(/^Dark/));
    expect(setChoice).toHaveBeenLastCalledWith('dark', { animate: false });
  });

  it('keeps the button inert if the styles fail to load, instead of taking the route down (L8)', async () => {
    vi.resetModules();
    vi.doMock('next/dynamic', () => ({
      default: () =>
        function FailingStyles(): never {
          throw new Error('chunk failed to load');
        },
    }));
    const { default: Menu } = await import('../ThemeMenu');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Menu />);
    fireEvent.click(button());
    expect(button()).not.toHaveAttribute('popovertarget');
    // The press stops waiting once the load has failed, so the button isn't left busy (D5).
    expect(button()).not.toHaveAttribute('aria-busy');
    expect(showPopover).not.toHaveBeenCalled();
    quiet.mockRestore();
    vi.doUnmock('next/dynamic');
  });
});
