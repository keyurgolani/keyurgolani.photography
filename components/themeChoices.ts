/** What the visitor chose, as stored. Dark is stored as `charcoal`; a legacy stored `dark` reads as Black. */
export type ThemeChoice = 'system' | 'light' | 'bright' | 'charcoal' | 'black';
/** What paints. System resolves to light or black; `charcoal` paints `dark`. */
export type Theme = 'light' | 'bright' | 'dark' | 'black';

/** The menu's order. components/site/themeScript.ts keeps its own copy, since it ships as a string. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'bright', 'charcoal', 'black'];
