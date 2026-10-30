/** What the visitor chose, as stored. v1.2.0's stored `light` and `dark` keep their meaning; the preview's `charcoal` reads as Dark. */
export type ThemeChoice = 'system' | 'light' | 'bright' | 'dark' | 'black';
/** What paints. System resolves to light or dark; Dark is today's site, Black is true black. */
export type Theme = 'light' | 'bright' | 'dark' | 'black';

/** The menu's order. components/site/themeScript.ts keeps its own copy, since it ships as a string. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'bright', 'dark', 'black'];
