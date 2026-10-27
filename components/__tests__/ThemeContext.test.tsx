import { Profiler } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

const html = document.documentElement;

describe('ThemeProvider', () => {
  beforeEach(() => {
    html.setAttribute('data-theme', 'dark');
    delete html.dataset.hydrated;
    localStorage.clear();
  });

  afterEach(() => {
    html.setAttribute('data-theme', 'dark');
  });

  it('renders its children on the first pass, in the dark theme the server sends', () => {
    // The server render runs no effects, so a gate that waits for a mount effect would send no child.
    let firstPass = '';
    function First() {
      const { theme } = useTheme();
      if (!firstPass) firstPass = theme;
      return <p>child</p>;
    }
    const markup = renderToString(
      <ThemeProvider>
        <First />
      </ThemeProvider>,
    );
    expect(markup).toContain('<p>child</p>');
    expect(firstPass).toBe('dark');
  });

  it('picks up the light theme the inline script put on <html>', () => {
    html.setAttribute('data-theme', 'light');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('light');
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

  it('marks <html> hydrated once its children have committed', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(html.dataset.hydrated).toBe('true');
  });

  it('writes the attribute and localStorage.theme on each toggle', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => fireEvent.click(screen.getByRole('button')));
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(screen.getByRole('button')).toHaveTextContent('light');

    act(() => fireEvent.click(screen.getByRole('button')));
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('still flips both ways when localStorage throws on write', () => {
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
      expect(screen.getByRole('button')).toHaveTextContent('light');
      act(() => fireEvent.click(screen.getByRole('button')));
      expect(html.getAttribute('data-theme')).toBe('dark');
      expect(screen.getByRole('button')).toHaveTextContent('dark');
    } finally {
      setItem.mockRestore();
    }
  });
});
