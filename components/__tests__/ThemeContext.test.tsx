import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    let firstPass = '';
    function First() {
      const { theme } = useTheme();
      if (!firstPass) firstPass = theme;
      return <p>child</p>;
    }
    render(
      <ThemeProvider>
        <First />
      </ThemeProvider>,
    );
    expect(screen.getByText('child')).toBeInTheDocument();
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
});
