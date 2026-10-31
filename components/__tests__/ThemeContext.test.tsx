import { Profiler, Suspense } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useSetThemeChoice, useThemeChoice } from '../ThemeContext';

/** Reads the choice and what paints, and flips between Light and Black. */
function Probe() {
  const { choice, theme, setChoice } = useThemeChoice();
  return (
    <button type="button" onClick={() => setChoice(theme === 'light' ? 'black' : 'light')}>
      {choice}/{theme}
    </button>
  );
}

const html = document.documentElement;

describe('ThemeProvider', () => {
  beforeEach(() => {
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
    delete html.dataset.hydrated;
    localStorage.clear();
  });

  afterEach(() => {
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-theme-choice', 'system');
  });

  it('renders its children on the first pass, in System painting Dark, as the server sends', () => {
    // The server render runs no effects, so a gate that waits for a mount effect would send no child.
    let firstPass = '';
    function First() {
      const { choice, theme } = useThemeChoice();
      if (!firstPass) firstPass = `${choice}/${theme}`;
      return <p>child</p>;
    }
    const markup = renderToString(
      <ThemeProvider>
        <First />
      </ThemeProvider>,
    );
    expect(markup).toContain('<p>child</p>');
    expect(firstPass).toBe('system/dark');
  });

  it('picks up the light theme the inline script put on <html>', () => {
    html.setAttribute('data-theme', 'light');
    html.setAttribute('data-theme-choice', 'light');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('light/light');
  });

  it('renders once for a stored light theme, so no context change reaches a boundary still streaming in', () => {
    // A second commit on mount would be a context change above every Suspense boundary, which React then renders
    // again on the client instead of hydrating: the curator's inbox, opened in the light theme, didn't land on #item.
    html.setAttribute('data-theme', 'light');
    const commits: string[] = [];
    render(
      <Profiler id="theme" onRender={(_id, phase) => commits.push(phase)}>
        <ThemeProvider>
          <p>child</p>
        </ThemeProvider>
      </Profiler>,
    );
    expect(html.dataset.hydrated).toBe('true');
    expect(commits).toEqual(['mount']);
  });

  describe('hydrating a stored light theme', () => {
    // The setter alone, as a control that never reads the theme: no subscription, so no render after hydration.
    function Toggle() {
      const setChoice = useSetThemeChoice();
      return (
        <button type="button" onClick={() => setChoice('light')}>
          toggle
        </button>
      );
    }

    async function hydrate(tree: React.ReactElement) {
      const container = document.createElement('div');
      container.innerHTML = renderToString(tree);
      document.body.appendChild(container);
      // The inline script put the stored light theme on <html> before React ran.
      html.setAttribute('data-theme', 'light');
      const recovered: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot> | undefined;
      const streamed = container.querySelector('[data-streamed]');
      await act(async () => {
        root = hydrateRoot(container, tree, { onRecoverableError: (error) => recovered.push(error) });
      });
      return {
        container,
        recovered,
        streamed,
        done: () => {
          act(() => root?.unmount());
          container.remove();
        },
      };
    }

    it('takes one commit, so the provider never changes its value under the page', async () => {
      const commits: string[] = [];
      const { recovered, done } = await hydrate(
        <Profiler id="theme" onRender={(_id, phase) => commits.push(phase)}>
          <ThemeProvider>
            <Toggle />
          </ThemeProvider>
        </Profiler>,
      );
      try {
        expect(html.dataset.hydrated).toBe('true');
        expect(recovered).toEqual([]);
        expect(commits).toEqual(['mount']);
      } finally {
        done();
      }
    });

    // What this pins: hydrating over a pending boundary keeps the server's fallback and recovers from nothing. It passes on the
    // old provider too: jsdom gives the boundary no content to reveal, so a client render of it never commits. The bug itself,
    // a pending boundary rendered again on the client, is the inbox e2e's light-theme phone case; the commit count above pins its
    // cause.
    it('hydrates over a boundary still pending, keeping the server fallback, with nothing to recover from', async () => {
      // The server's HTML for a boundary still pending, waiting for its reveal (`$~`; jsdom's document has finished loading,
      // where React reads a bare `$?` as a boundary the server gave up on).
      const pending = '<button type="button">toggle</button><!--$~--><template id="B:0"></template><p data-fallback="">loading</p><!--/$-->';
      const never = new Promise<never>(() => undefined);
      function Streamed(): React.ReactElement {
        throw never;
      }
      const container = document.createElement('div');
      container.innerHTML = pending;
      document.body.appendChild(container);
      html.setAttribute('data-theme', 'light');
      const fallback = container.querySelector('[data-fallback]');
      const recovered: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot> | undefined;
      try {
        await act(async () => {
          root = hydrateRoot(
            container,
            <ThemeProvider>
              <Toggle />
              <Suspense fallback={<p data-fallback="">loading</p>}>
                <Streamed />
              </Suspense>
            </ThemeProvider>,
            { onRecoverableError: (error) => recovered.push(error) },
          );
        });
        expect(html.dataset.hydrated).toBe('true');
        expect(recovered).toEqual([]);
        // Still the server's fallback, inside the server's pending marker: nothing rendered it again.
        expect(container.querySelector('[data-fallback]')).toBe(fallback);
        expect(container.innerHTML).toContain('<!--$~-->');
      } finally {
        act(() => root?.unmount());
        container.remove();
      }
    });
  });

  it('marks <html> hydrated once its children have committed', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(html.dataset.hydrated).toBe('true');
  });

  it('writes both attributes and localStorage.theme on each choice', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => fireEvent.click(screen.getByRole('button')));
    expect([html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')]).toEqual(['light', 'light']);
    expect(localStorage.getItem('theme')).toBe('light');
    expect(screen.getByRole('button')).toHaveTextContent('light/light');

    act(() => fireEvent.click(screen.getByRole('button')));
    expect([html.getAttribute('data-theme-choice'), html.getAttribute('data-theme')]).toEqual(['black', 'black']);
    expect(localStorage.getItem('theme')).toBe('black');
    expect(screen.getByRole('button')).toHaveTextContent('black/black');
  });

  it('follows the inline script when it changes <html>, as System does when the device switches', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('system/dark');
    await act(async () => {
      html.setAttribute('data-theme', 'light');
    });
    expect(screen.getByRole('button')).toHaveTextContent('system/light');
  });

  it('still applies a choice when localStorage throws on write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      act(() => fireEvent.click(screen.getByRole('button')));
      expect(html.getAttribute('data-theme')).toBe('light');
      expect(screen.getByRole('button')).toHaveTextContent('light/light');
      act(() => fireEvent.click(screen.getByRole('button')));
      expect(html.getAttribute('data-theme')).toBe('black');
      expect(screen.getByRole('button')).toHaveTextContent('black/black');
    } finally {
      setItem.mockRestore();
    }
  });

  it('paints the browser bar with an explicit choice, and puts System\'s pair back', async () => {
    const light = Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#ebe5d9' });
    light.media = '(prefers-color-scheme: light)';
    const dark = Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#080a09' });
    dark.media = '(prefers-color-scheme: dark)';
    document.head.append(light, dark);
    try {
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      act(() => fireEvent.click(screen.getByRole('button')));
      act(() => fireEvent.click(screen.getByRole('button')));
      expect([light.content, dark.content]).toEqual(['#000000', '#000000']);
      // A choice made in another tab reaches the provider through the inline script's write on <html>.
      await act(async () => {
        html.setAttribute('data-theme-choice', 'system');
        html.setAttribute('data-theme', 'dark');
      });
      expect([light.content, dark.content]).toEqual(['#ebe5d9', '#080a09']);
    } finally {
      light.remove();
      dark.remove();
    }
  });

  it('turns transitions off while a new theme lands, for two frames, and not for a write of the same theme', async () => {
    // Each frame's callbacks, run by hand: the guard must outlast the frame the new theme's styles land in.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const nextFrame = () => frames.splice(0).forEach((callback) => callback(0));
    try {
      const { unmount } = render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      await act(async () => {
        html.setAttribute('data-theme', 'dark');
      });
      expect(html.hasAttribute('data-theme-swap')).toBe(false);

      act(() => fireEvent.click(screen.getByRole('button')));
      await act(async () => {});
      expect(html.hasAttribute('data-theme-swap')).toBe(true);
      nextFrame();
      expect(html.hasAttribute('data-theme-swap')).toBe(true);
      nextFrame();
      expect(html.hasAttribute('data-theme-swap')).toBe(false);

      // The inline script's write (System following the device) is guarded too, and unmounting clears a guard.
      await act(async () => {
        html.setAttribute('data-theme', 'dark');
      });
      expect(html.hasAttribute('data-theme-swap')).toBe(true);
      unmount();
      expect(html.hasAttribute('data-theme-swap')).toBe(false);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });
});
