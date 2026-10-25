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
    // Storage, identity, media, and catalog code runs in the watcher and CLI
    // too, so it must not depend on Next or on server-only's bundler check.
    // In lib/catalog, only request.ts and public-reader.ts, which only the
    // web process imports, may.
    files: ['lib/storage/**', 'lib/identity/**', 'lib/media/**', 'lib/catalog/**'],
    ignores: ['lib/catalog/request.ts', 'lib/catalog/public-reader.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'This code runs outside Next. Keep Next imports in app/, proxy.ts, or lib/catalog/request.ts.' },
            { name: 'server-only', message: 'This code runs under plain Node, where server-only throws. Only lib/catalog/public-reader.ts may import it.' },
          ],
          patterns: [
            { group: ['next/*'], message: 'This code runs outside Next. Keep Next imports in app/, proxy.ts, or lib/catalog/request.ts.' },
          ],
        },
      ],
    },
  },
)
