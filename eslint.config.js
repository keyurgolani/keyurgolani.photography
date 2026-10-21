import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// The handlers a non-interactive element may not carry. Leaving out the mouse
// move and enter events keeps ParallaxCard's hover-only tilt legal.
const handlers = ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp']

export default tseslint.config(
  {
    ignores: [
      'dist',
      '.next*',
      '.next*/**',
      'out',
      'build',
      'next-env.d.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Next route files export their metadata, viewport, and share image fields beside the component.
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['metadata', 'generateMetadata', 'viewport', 'alt', 'size', 'contentType'] },
      ],
    },
  },
  {
    // Contract rule 1 in docs/accessibility-contract.md: the focusable element owns the handler.
    files: ['**/*.tsx'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
      'jsx-a11y/alt-text': ['error', { img: ['Image'] }],
      'jsx-a11y/no-static-element-interactions': ['error', { handlers }],
      'jsx-a11y/no-noninteractive-element-interactions': ['error', { handlers }],
    },
  },
  {
    // Playwright runs in Node, and its fixture callback `use()` isn't a React hook.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    // Storage, identity, and media code runs in the watcher and CLI too, so it
    // must not depend on Next or on server-only's bundler check.
    files: ['lib/storage/**', 'lib/identity/**', 'lib/media/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'lib/storage, lib/identity, and lib/media run outside Next. Keep Next imports in app/ or proxy.ts.' },
            { name: 'server-only', message: 'lib/storage, lib/identity, and lib/media run under plain Node, where server-only throws.' },
          ],
          patterns: [
            { group: ['next/*'], message: 'lib/storage, lib/identity, and lib/media run outside Next. Keep Next imports in app/ or proxy.ts.' },
          ],
        },
      ],
    },
  },
)
