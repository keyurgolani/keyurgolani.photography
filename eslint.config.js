import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// The handlers a non-interactive element may not carry. Leaving out the mouse
// move and enter events keeps ParallaxCard's hover-only tilt legal.
const handlers = ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp']

const NEXT_MESSAGE = 'This code runs outside Next. Keep Next imports in app/, proxy.ts, or lib/catalog/request.ts.'
const NEXT_PATHS = [
  { name: 'next', message: NEXT_MESSAGE },
  { name: 'server-only', message: 'This code runs under plain Node, where server-only throws. Only lib/catalog/public-reader.ts may import it.' },
]
const NEXT_PATTERNS = [{ group: ['next/*'], message: NEXT_MESSAGE }]
// Ingestion never authors order (#8). The watcher process may read the
// working layer, but never load the sequence operations or the authored
// writer, by alias or relative path. Flat config replaces a rule's options
// per file, so every entry that sets no-restricted-imports for a watcher
// path repeats this pattern.
const ORDER_WRITER_PATTERNS = [
  {
    regex: '(^|/)catalog/(sequence|working-layer-writer)',
    message: 'Ingestion never authors order. The watcher process may read lib/catalog/working-layer.ts, but not import the sequence operations or the authored writer.',
  },
]

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
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
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
    // Storage, identity, and media code runs in the watcher and CLI, so it
    // must not depend on Next or on server-only's bundler check, and the
    // watcher process must not reach the order writers.
    files: ['lib/storage/**', 'lib/identity/**', 'lib/media/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: [...NEXT_PATTERNS, ...ORDER_WRITER_PATTERNS] }],
    },
  },
  {
    // The rest of the watcher process. #17's curation actions, policy, and
    // resolutions, and #14's auth, run only in the CLI or curator process.
    files: ['scripts/imageWatcher.ts', 'utils/**', 'lib/ingest/**', 'lib/curation/**'],
    ignores: [
      '**/__tests__/**',
      'lib/curation/actions.ts',
      'lib/curation/policy.ts',
      'lib/curation/resolutions.ts',
      'lib/curation/auth.ts',
      'lib/curation/auth/**',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: ORDER_WRITER_PATTERNS }],
    },
  },
  {
    // Catalog code runs in the CLI too, so only request.ts and
    // public-reader.ts, which only the web process imports, may use Next or
    // server-only. sequence.ts and its callers import the writer.
    files: ['lib/catalog/**'],
    ignores: ['lib/catalog/request.ts', 'lib/catalog/public-reader.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: NEXT_PATTERNS }],
    },
  },
)
