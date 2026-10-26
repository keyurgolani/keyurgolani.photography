import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// The handlers a non-interactive element may not carry. Hover-only handlers,
// such as a pointer move, aren't among them.
const handlers = ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp']

const NEXT_MESSAGE = 'This code runs outside Next. Keep Next imports in app/, proxy.ts, or lib/catalog/request.ts.'
const NEXT_PATHS = [
  { name: 'next', message: NEXT_MESSAGE },
  { name: 'server-only', message: 'This code runs under plain Node, where server-only throws. Only lib/catalog/public-reader.ts, reader.ts, projections/work.ts, projections/home.ts, projections/viewer.ts, and projections/series.ts may import it.' },
]
// The reader and the Work, Home, Viewer, and series projections carry
// server-only so a client bundle that reaches them fails the build (#3, #4, #7,
// #5). Nothing the CLI, the watcher, Playwright, or ci/publish-fixture.ts loads
// reaches them at runtime, which lib/catalog/__tests__/clientImports.test.ts
// checks. They still may not use Next.
const SERVER_ONLY_CATALOG = ['lib/catalog/reader.ts', 'lib/catalog/projections/work.ts', 'lib/catalog/projections/home.ts', 'lib/catalog/projections/viewer.ts', 'lib/catalog/projections/series.ts']
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

// Rules run through lib/catalog/ruleset.ts, which registers every rule
// module. rules.ts alone lacks the asset rules, so a process that ran rules
// from it would skip them and record another rulesetVersion. Only rules.ts's
// own tests run rules from it. Like the pattern above, every entry that sets
// no-restricted-imports for production code repeats this one.
const RULE_RUNNER_PATTERNS = [
  {
    regex: '(^|/)rules$',
    importNames: ['runRules', 'rulesetVersion', 'registeredRules'],
    message: 'Run rules through lib/catalog/ruleset.ts, which registers every rule module.',
  },
]
const PRODUCTION_CODE = ['lib/**', 'app/**', 'scripts/**', 'components/**', 'utils/**', 'proxy.ts']
const TESTS_AND_RULESET = ['**/__tests__/**', 'lib/catalog/ruleset.ts']

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
    // Every process runs the whole ruleset.
    files: PRODUCTION_CODE,
    ignores: TESTS_AND_RULESET,
    rules: {
      'no-restricted-imports': ['error', { patterns: RULE_RUNNER_PATTERNS }],
    },
  },
  {
    // Storage, identity, and media code runs in the watcher and CLI, so it
    // must not depend on Next or on server-only's bundler check, and the
    // watcher process must not reach the order writers.
    files: ['lib/storage/**', 'lib/identity/**', 'lib/media/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: [...NEXT_PATTERNS, ...ORDER_WRITER_PATTERNS, ...RULE_RUNNER_PATTERNS] }],
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
      'no-restricted-imports': ['error', { patterns: [...ORDER_WRITER_PATTERNS, ...RULE_RUNNER_PATTERNS] }],
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
  {
    // The same, outside the tests and ruleset.ts, which also run the whole ruleset.
    files: ['lib/catalog/**'],
    ignores: ['lib/catalog/request.ts', 'lib/catalog/public-reader.ts', ...TESTS_AND_RULESET],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: [...NEXT_PATTERNS, ...RULE_RUNNER_PATTERNS] }],
    },
  },
  {
    files: SERVER_ONLY_CATALOG,
    rules: {
      'no-restricted-imports': ['error', { paths: [NEXT_PATHS[0]], patterns: [...NEXT_PATTERNS, ...RULE_RUNNER_PATTERNS] }],
    },
  },
)
