// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cssModuleClasses, curatorCssFindings, modulesInCss } from './curator-css.mjs';

// A CSS module's class map as Turbopack writes it into a server chunk, and the source naming it in that chunk's map.
const classMap = (names) => `__turbopack_context__.v({\n${Object.entries(names).map(([name, value]) => `  "${name}": "${value}",\n`).join('')}});\n`;
const source = (file, layer = 'app-rsc') => `turbopack:///[project]/${file} [${layer}] (css module)`;

const INBOX = 'app/curation/inbox/loading.module.css';
const CURATOR = 'app/curation/curator.module.css';
const LOADING = 'components/site/LoadingState.module.css';

describe('cssModuleClasses', () => {
  it("reads each CSS module's hashed names from a source map, by its path, and nothing from other sources", () => {
    const map = {
      version: 3,
      sources: [source(INBOX), '../../../../app/curation/inbox/loading.tsx', source(LOADING)],
      sourcesContent: [classMap({ noScriptNote: 'uGNq4G_noScriptNote' }), 'export default function InboxLoading() {}', classMap({ label: 'c2zNGq_label', state: 'c2zNGq_state' })],
    };
    expect(cssModuleClasses(map)).toEqual(
      new Map([
        [INBOX, new Set(['uGNq4G_noScriptNote'])],
        [LOADING, new Set(['c2zNGq_label', 'c2zNGq_state'])],
      ]),
    );
  });

  it('reads a sectioned map, and both layers of one module into one entry', () => {
    const map = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { sources: [source(CURATOR)], sourcesContent: [classMap({ page: '_4rXkPG_page' })] } },
        { offset: { line: 9, column: 0 }, map: { sources: [source(CURATOR, 'app-ssr')], sourcesContent: [classMap({ list: '_4rXkPG_list' })] } },
      ],
    };
    expect(cssModuleClasses(map)).toEqual(new Map([[CURATOR, new Set(['_4rXkPG_page', '_4rXkPG_list'])]]));
  });

  it("keeps only a name's own class when it composes others", () => {
    const map = { sources: [source(CURATOR)], sourcesContent: [classMap({ row: '_4rXkPG_row c2zNGq_state' })] };
    expect(cssModuleClasses(map).get(CURATOR)).toEqual(new Set(['_4rXkPG_row']));
  });

  it('keeps a module with no names, as an empty set, and skips a source with no content', () => {
    const map = { sources: [source(INBOX), source(LOADING)], sourcesContent: [classMap({}), null] };
    expect(cssModuleClasses(map)).toEqual(new Map([[INBOX, new Set()]]));
  });
});

describe('modulesInCss', () => {
  const classes = new Map([
    [INBOX, new Set(['uGNq4G_noScriptNote'])],
    [LOADING, new Set(['c2zNGq_label', 'c2zNGq_reveal'])],
  ]);

  it("finds a module by any of its names, as a selector or a keyframe's name", () => {
    expect(modulesInCss('.kPSjjq_card{width:100%}.uGNq4G_noScriptNote{margin:0}', classes)).toEqual([INBOX]);
    expect(modulesInCss('.x{animation:c2zNGq_reveal 1s}', classes)).toEqual([LOADING]);
    expect(modulesInCss(':is(.a,.uGNq4G_noScriptNote):hover{} .c2zNGq_label>p{}', classes)).toEqual([INBOX, LOADING]);
  });

  it("matches a whole name only, never one that's part of a longer name", () => {
    expect(modulesInCss('.uGNq4G_noScriptNoteWide{} .xuGNq4G_noScriptNote{} .uGNq4G_noScriptNote-2{}', classes)).toEqual([]);
  });
});

describe('curatorCssFindings', () => {
  const classes = new Map([
    [INBOX, new Set(['uGNq4G_noScriptNote'])],
    [CURATOR, new Set(['_4rXkPG_page'])],
    [LOADING, new Set(['c2zNGq_label'])],
  ]);
  const sources = [CURATOR, INBOX];
  const shared = { file: 'static/chunks/0_9p0p-o0whc-.css', css: '.c2zNGq_label{opacity:0}.uGNq4G_noScriptNote{margin:0}' };
  const clean = { file: 'static/chunks/35iakrcfeim_i.css', css: ':root{--gah-ink:#fff}.c2zNGq_label{opacity:0}' };

  it('names the route, the module and the file for each curator module a visitor route loads', () => {
    const routes = [
      { name: 'Home', sheets: [clean, shared] },
      { name: 'About', sheets: [clean, { file: 'app/about/aboutThemes.ts (ABOUT_THEMES_CSS, inline)', css: '._4rXkPG_page{}' }] },
      { name: 'Work', sheets: [clean] },
    ];
    expect(curatorCssFindings({ routes, classes, sources })).toEqual([
      `Home loads ${INBOX}, in static/chunks/0_9p0p-o0whc-.css.`,
      `About loads ${CURATOR}, in app/about/aboutThemes.ts (ABOUT_THEMES_CSS, inline).`,
    ]);
  });

  it("passes a visitor route that loads shared modules only", () => {
    expect(curatorCssFindings({ routes: [{ name: 'Home', sheets: [clean] }], classes, sources })).toEqual([]);
  });

  it("fails closed on a curator stylesheet it can't trace: a plain sheet, one with no names, one the build's maps lack", () => {
    const findings = curatorCssFindings({
      routes: [{ name: 'Home', sheets: [clean] }],
      classes: new Map([...classes, ['app/curation/series/series.module.css', new Set()]]),
      sources: [...sources, 'app/curation/inbox/plain.css', 'app/curation/series/series.module.css', 'app/curation/login/login.module.css'],
    });
    expect(findings).toEqual([
      "app/curation/inbox/plain.css is a plain stylesheet, which this guard can't trace to a route. Make it a CSS module.",
      expect.stringMatching(/^app\/curation\/series\/series\.module\.css has no class names in the build's server source maps/),
      expect.stringMatching(/^app\/curation\/login\/login\.module\.css has no class names in the build's server source maps/),
    ]);
  });
});
