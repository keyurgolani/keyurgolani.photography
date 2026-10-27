import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../ThemeContext';
import ThemeToggle, { THEME_TOGGLE_DESCRIPTION } from '../ThemeToggle';

const html = document.documentElement;

const renderToggle = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );

describe('ThemeToggle', () => {
  afterEach(() => {
    html.setAttribute('data-theme', 'dark');
    localStorage.clear();
  });

  it('says what the theme changes in its description, outside its name', () => {
    renderToggle();
    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleDescription(THEME_TOGGLE_DESCRIPTION);
    expect(button.textContent).not.toContain(THEME_TOGGLE_DESCRIPTION);
    // It names the page, not its content: after the catalog cutover /gallery goes to Work, a photo grid the theme doesn't reach.
    expect(THEME_TOGGLE_DESCRIPTION).toBe("Changes only Home's opening screen and the Gallery archive; other pages keep their colors.");
  });

  it('keeps the description out of view, so nothing shows beside the icon', () => {
    renderToggle();
    const description = document.getElementById(screen.getByRole('button').getAttribute('aria-describedby') ?? '');
    expect(description).not.toBeNull();
    expect(description).not.toBeVisible();
  });

  it.each(['dark', 'light'])('carries the same description in the %s theme', (theme) => {
    html.setAttribute('data-theme', theme);
    renderToggle();
    expect(screen.getByRole('button')).toHaveAccessibleDescription(THEME_TOGGLE_DESCRIPTION);
  });

  it('sends the description in the server HTML, so it is there before React runs', () => {
    const markup = renderToString(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const id = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`id="${id}" hidden=""`);
    expect(markup).toContain(THEME_TOGGLE_DESCRIPTION.replace("'", '&#x27;'));
  });
});
