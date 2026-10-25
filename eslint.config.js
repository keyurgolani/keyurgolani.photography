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
  { name: 'server-only', message: 'This code runs under plain Node, where server-only throws. Only lib/catalog/public-reader.ts, preview-reader.ts, reader.ts, projections/work.ts, projections/home.ts, projections/viewer.ts, and projections/series.ts may import it.' },
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
// #16's preview reader compiles the working layer, which holds drafts, so
// only the curator's routes and the catalog itself may import it, and the
// preview's routes never import the public reader, so draft and public data
// never mix in one response. Like the patterns above, every entry that sets
// no-restricted-imports outside those two folders repeats PREVIEW_READER_PATTERNS.
// Each specifier that resolves to the module, by alias or relative path:
// any extension TypeScript maps to it (`.js` under bundler resolution), a
// doubled or `./` separator, a trailing slash, and a query or fragment,
// which a bundler drops to find the file. Case-insensitive, as
// no-restricted-imports matches by default and macOS resolves. The modules
// under the preview's routes import the reader, so code outside
// app/curation/** may not import them either. A path that walks back with
// `..` is left to lib/catalog/__tests__/previewBoundary.test.ts, which
// walks every public module's imports.
const SUFFIX = '([?#].*)?$'
const catalogModule = (name) => `(^|/)catalog(/+\\.)*/+${name}(\\.[cm]?[jt]sx?)?/?${SUFFIX}`
const PREVIEW_READER_SPECIFIER = catalogModule('preview-reader')
const PUBLIC_READER_SPECIFIER = catalogModule('public-reader')
const PREVIEW_SUBTREE_SPECIFIER = `(^|/)curation(/+\\.)*/+preview(/.*)?${SUFFIX}`
const PREVIEW_READER_MESSAGE = 'Only app/curation/** and lib/catalog/** may import the preview reader, which reads drafts.'
const PREVIEW_SUBTREE_MESSAGE = "Only app/curation/** may import a module under the preview's routes, which reach the preview reader."
const PUBLIC_READER_MESSAGE = 'The preview renders the draft through lib/catalog/preview-reader.ts and never reads the public catalog.'
const PREVIEW_READER_PATTERNS = [
  { regex: PREVIEW_READER_SPECIFIER, message: PREVIEW_READER_MESSAGE },
  { regex: PREVIEW_SUBTREE_SPECIFIER, message: PREVIEW_SUBTREE_MESSAGE },
]
const PUBLIC_READER_PATTERNS = [{ regex: PUBLIC_READER_SPECIFIER, message: PUBLIC_READER_MESSAGE }]
// no-restricted-imports sees only static imports and exports, so these catch
// the module loaded any other way: `import()` with a string or a template
// (static, or ending in the module's path), `require()` or any other call
// given its path, and TypeScript's `import x = require()`. esquery's regex
// can't hold a `/`, so each one is written as \u002F, which RegExp reads as `/`.
// With `plainOnly`, a template is matched only when it has no expression,
// for code where COMPUTED_LOADS already reports every other one. With
// `loaderCalls`, only a call that loads a module counts, since a page's URL
// under /curation/preview/ is spelled like a module under the preview's routes.
const LOADER_CALL = ":matches([callee.type='Identifier'][callee.name='require'], [callee.object.name='require'], [callee.object.name='module'][callee.property.name='require'], [callee.object.name='vi'], [callee.type='CallExpression'])"
const loadedBy = (specifier, message, { plainOnly = false, loaderCalls = false } = {}) => {
  const re = `/${specifier.replaceAll('/', '\\u002F')}/i`
  const template = plainOnly ? 'TemplateLiteral[expressions.length=0]' : 'TemplateLiteral'
  const call = loaderCalls ? `CallExpression${LOADER_CALL}` : 'CallExpression'
  return [
    { selector: `ImportExpression[source.value=${re}]`, message },
    { selector: `ImportExpression > ${template}.source > TemplateElement[value.cooked=${re}]`, message },
    { selector: `${call} > Literal.arguments[value=${re}]`, message },
    { selector: `${call} > ${template}.arguments > TemplateElement[value.cooked=${re}]`, message },
    { selector: `TSExternalModuleReference > Literal[value=${re}]`, message },
  ]
}
const PREVIEW_READER_LOADS = [
  ...loadedBy(PREVIEW_READER_SPECIFIER, PREVIEW_READER_MESSAGE),
  ...loadedBy(PREVIEW_SUBTREE_SPECIFIER, PREVIEW_SUBTREE_MESSAGE, { loaderCalls: true }),
]
const PUBLIC_READER_LOADS = loadedBy(PUBLIC_READER_SPECIFIER, PUBLIC_READER_MESSAGE)
const PREVIEW_READERS = ['app/curation/**', 'lib/catalog/**']
// Production code outside those two folders names every module it loads
// with a plain string, so the rules above, and the import-graph test, can
// see what it loads: a bundler would fold a computed name back to a path
// neither can read. It also never names, or computes, a registered symbol's
// key, so it can't read the preview reader's process-wide cache.
const COMPUTED_MESSAGE = 'Outside app/curation/** and lib/catalog/**, name a module or a Symbol.for() key with a plain string, so the preview reader, which reads drafts, provably stays out.'
const PLAIN = ":not(Literal):not(TemplateLiteral[expressions.length=0])"
const LOADER = ":matches([callee.type='Identifier'][callee.name='require'], [callee.object.name='require'], [callee.object.name='module'][callee.property.name='require'], [callee.object.name='Symbol'][callee.property.name='for'])"
const COMPUTED_LOADS = [
  { selector: `ImportExpression > .source${PLAIN}`, message: COMPUTED_MESSAGE },
  { selector: `CallExpression${LOADER} > .arguments:first-child${PLAIN}`, message: COMPUTED_MESSAGE },
  { selector: "CallExpression[callee.object.name='require'][callee.property.name='context']", message: COMPUTED_MESSAGE },
  { selector: 'Literal[value=/kg\\.catalog\\.previewReader/]', message: COMPUTED_MESSAGE },
  { selector: 'TemplateElement[value.cooked=/kg\\.catalog\\.previewReader/]', message: COMPUTED_MESSAGE },
]
const PRODUCTION_LOADS = [
  ...loadedBy(PREVIEW_READER_SPECIFIER, PREVIEW_READER_MESSAGE, { plainOnly: true }),
  ...loadedBy(PREVIEW_SUBTREE_SPECIFIER, PREVIEW_SUBTREE_MESSAGE, { plainOnly: true, loaderCalls: true }),
  ...COMPUTED_LOADS,
]
const MODULES = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

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
    // Next and Node load .jsx, .mts and .cts too, so each is linted.
    files: ['**/*.{ts,tsx,mts,cts,jsx}'],
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
    files: ['**/*.{tsx,jsx}'],
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
    // Tests and tooling too: only the curator's routes and the catalog reach the preview reader.
    files: [MODULES],
    ignores: PREVIEW_READERS,
    rules: {
      'no-restricted-imports': ['error', { patterns: PREVIEW_READER_PATTERNS }],
      'no-restricted-syntax': ['error', ...PREVIEW_READER_LOADS],
    },
  },
  {
    // Production code, where a computed name is refused too. With the
    // preview's block below, the only no-restricted-syntax entries, so
    // nothing else replaces them.
    files: [...PRODUCTION_CODE, 'instrumentation.ts'],
    ignores: [...TESTS_AND_RULESET, '**/*.test.*', ...PREVIEW_READERS],
    rules: {
      'no-restricted-syntax': ['error', ...PRODUCTION_LOADS],
    },
  },
  {
    // Every process runs the whole ruleset.
    files: PRODUCTION_CODE,
    ignores: [...TESTS_AND_RULESET, ...PREVIEW_READERS],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...RULE_RUNNER_PATTERNS, ...PREVIEW_READER_PATTERNS] }],
    },
  },
  {
    files: PREVIEW_READERS,
    ignores: TESTS_AND_RULESET,
    rules: {
      'no-restricted-imports': ['error', { patterns: RULE_RUNNER_PATTERNS }],
    },
  },
  {
    // #16's preview subtree renders the draft only.
    files: ['app/curation/**/preview/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...RULE_RUNNER_PATTERNS, ...PUBLIC_READER_PATTERNS] }],
      'no-restricted-syntax': ['error', ...PUBLIC_READER_LOADS],
    },
  },
  {
    // Storage, identity, and media code runs in the watcher and CLI, so it
    // must not depend on Next or on server-only's bundler check, and the
    // watcher process must not reach the order writers.
    files: ['lib/storage/**', 'lib/identity/**', 'lib/media/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: [...NEXT_PATTERNS, ...ORDER_WRITER_PATTERNS, ...RULE_RUNNER_PATTERNS, ...PREVIEW_READER_PATTERNS] }],
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
      'no-restricted-imports': ['error', { patterns: [...ORDER_WRITER_PATTERNS, ...RULE_RUNNER_PATTERNS, ...PREVIEW_READER_PATTERNS] }],
    },
  },
  {
    // Catalog code runs in the CLI too, so only request.ts, preview-reader.ts and
    // public-reader.ts, which only the web and curator processes import, may use Next or
    // server-only. sequence.ts and its callers import the writer.
    files: ['lib/catalog/**'],
    ignores: ['lib/catalog/request.ts', 'lib/catalog/public-reader.ts', 'lib/catalog/preview-reader.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: NEXT_PATHS, patterns: NEXT_PATTERNS }],
    },
  },
  {
    // The same, outside the tests and ruleset.ts, which also run the whole ruleset.
    files: ['lib/catalog/**'],
    ignores: ['lib/catalog/request.ts', 'lib/catalog/public-reader.ts', 'lib/catalog/preview-reader.ts', ...TESTS_AND_RULESET],
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
