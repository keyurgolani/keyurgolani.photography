// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './helpers/runTsx';

// The Dark parity gate's helpers have one home, test/helpers/parityWalk.ts, and e2e/themes/computed.ts only re-exports
// it with `export *`. A named re-export beside `export *` silently wins over it, so with a second copy the gate could
// run one compare() while the unit tests pin another. This reads the files as text and parses each with the
// TypeScript compiler on its own, with no program and no import of any of them, so it sees every copy, wherever it's
// defined, and how the gate takes it.

const HOME = 'test/helpers/parityWalk.ts';
const COMPUTED = 'e2e/themes/computed.ts';
const GATE = 'e2e/themes/dark-parity.spec.ts';
const SCANNED = ['test', 'e2e', '__tests__'];
const SYMBOLS = ['compare', 'walk', 'failures', 'FOLD_PAINT', 'PROPERTIES', 'GEOMETRY_SLACK', 'completeHiddenSegments'] as const;
/** The gate's helpers and the parity types, which the gate takes from ./computed alone. */
const GATE_NAMES = [...SYMBOLS, 'Walk', 'Walked', 'Comparison', 'Allowance', 'WalkOptions', 'FoldedFocus', 'EvaluatingPage'];

/** Top-level definitions of `name` in `source`, exported or not: a local one inside a function is indented. */
function definitions(source: string, name: string, file?: string): number {
    void file;
    const pattern = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`, 'gm');
    return source.match(pattern)?.length ?? 0;
}

/** Named exports of `name` in `source`, as `export { … }` with or without `from`, by the name they export. */
function namedExports(source: string, name: string, file?: string): number {
    void file;
    let count = 0;
    for (const [, list] of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
        for (const item of list.split(',')) {
            const exported = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim();
            if (exported === name) count += 1;
        }
    }
    return count;
}

/** Where `source` takes any of `names` from, other than `allowed`, by its static import lists. */
function takenElsewhere(source: string, names: readonly string[], allowed: string, file?: string): string[] {
    void file;
    const offenders: string[] = [];
    for (const [, list, from] of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)) {
        for (const item of list.split(',')) {
            const local = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim() ?? '';
            if (names.includes(local) && from !== allowed) offenders.push(`${local} from ${from}`);
        }
    }
    return offenders;
}

/** Declarations of `name` anywhere in `source`. */
function declarations(source: string, name: string, file?: string): number {
    void file;
    return source.match(new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`, 'g'))?.length ?? 0;
}

/** `source` without its comments and blank lines. */
const code = (source: string) =>
    source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\/\/.*$/, '').trimEnd())
        .filter((line) => line !== '')
        .join('\n');

function sources(): { file: string; text: string }[] {
    const found: { file: string; text: string }[] = [];
    for (const dir of SCANNED) {
        for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
            if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
            const file = path.join(entry.parentPath, entry.name);
            found.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') });
        }
    }
    return found;
}

describe('the matchers this check counts with', () => {
    it('count a top-level definition, exported or not, and not a local one', () => {
        expect(definitions('export function compare(base: Walk) {}\n', 'compare')).toBe(1);
        expect(definitions('export const failures = (c: Comparison) => [];\n', 'failures')).toBe(1);
        expect(definitions('const GEOMETRY_SLACK = 0;\nexport const PROPERTIES = [];\n', 'GEOMETRY_SLACK')).toBe(1);
        expect(definitions('function walk() {\n    const walk = () => 1;\n}\n', 'walk')).toBe(1);
        expect(definitions('function sort() {\n    const compare = (a: string, b: string) => 0;\n}\n', 'compare')).toBe(0);
        expect(definitions('export const compareAll = 1;\n', 'compare')).toBe(0);
    });

    it('count a top-level definition however it is indented', () => {
        expect(definitions('if (ready) start();\n    export function compare() {}\n', 'compare')).toBe(1);
    });

    it('count a destructured const, and one of several declarators', () => {
        expect(definitions('export const { compare } = helpers;\n', 'compare')).toBe(1);
        expect(definitions('export const [, walk] = pair;\n', 'walk')).toBe(1);
        expect(definitions('export const a = 1, compare = () => 0;\n', 'compare')).toBe(1);
    });

    it('count a generator and a default-exported function, and overloads as one', () => {
        expect(definitions('export function *compare() {}\n', 'compare')).toBe(1);
        expect(definitions('export default function compare() {}\n', 'compare')).toBe(1);
        expect(definitions('export function compare(a: string): void;\nexport function compare(a: number): void;\nexport function compare(a: unknown) {}\n', 'compare')).toBe(1);
    });

    it('count no declaration inside a block, and no text inside a string', () => {
        expect(definitions('function outer() {\nconst compare = 1;\nreturn compare;\n}\n', 'compare')).toBe(0);
        expect(definitions('const sample = `\nexport function compare() {}\n`;\n', 'compare')).toBe(0);
    });

    it('count a named export, on one line or several, typed or renamed, and not a star export', () => {
        expect(namedExports("export { GEOMETRY_SLACK, compare, type Walk } from './parityCompare';", 'compare')).toBe(1);
        expect(namedExports("export {\n    failures,\n    walk as walked,\n} from './other';", 'failures')).toBe(1);
        expect(namedExports("export { compare as walk } from './other';", 'walk')).toBe(1);
        expect(namedExports("export type { Walk } from './other';\nexport { compare };", 'compare')).toBe(1);
        expect(namedExports("export * from './parityWalk';", 'compare')).toBe(0);
    });

    it('count a named export with no spaces, with comments in its list, and as export * as', () => {
        expect(namedExports("export{compare}from'./other';", 'compare')).toBe(1);
        expect(namedExports("export { /* the gate's */ compare, // and its verdict\n    failures } from './other';", 'compare')).toBe(1);
        expect(namedExports("export * as compare from './other';", 'compare')).toBe(1);
    });

    it('find a gate helper or type taken from anywhere but ./computed, however it is imported', () => {
        expect(takenElsewhere("import { compare, failures, type Walk } from './computed';", GATE_NAMES, './computed')).toEqual([]);
        expect(takenElsewhere("import { compare } from '../../lib/parity';", GATE_NAMES, './computed')).toEqual(['compare from ../../lib/parity']);
        expect(takenElsewhere("import{compare}from'../support/parity';", GATE_NAMES, './computed')).toEqual(['compare from ../support/parity']);
        expect(takenElsewhere("import type { Walk } from '../../test/helpers/parityWalk';", GATE_NAMES, './computed')).toEqual(['Walk from ../../test/helpers/parityWalk']);
        expect(takenElsewhere("import { walk as compare } from './computed';", GATE_NAMES, './computed')).toEqual(['walk from ./computed', 'compare from ./computed']);
        expect(takenElsewhere("import { compare as judge } from '../../components/__tests__/parity';", GATE_NAMES, './computed')).toEqual(['compare from ../../components/__tests__/parity']);
    });

    it('find one taken through a namespace, a dynamic import or require', () => {
        expect(takenElsewhere("import * as parity from '../../lib/parity';\nparity.compare(a, b);", GATE_NAMES, './computed')).toEqual(['compare from ../../lib/parity']);
        expect(takenElsewhere("async function load() {\n    const { compare } = await import('../../lib/parity');\n}", GATE_NAMES, './computed')).toEqual(['compare from ../../lib/parity']);
        expect(takenElsewhere("const { failures } = require('../../lib/parity');", GATE_NAMES, './computed')).toEqual(['failures from ../../lib/parity']);
        expect(takenElsewhere("const judge = (await import('../../lib/parity')).compare;", GATE_NAMES, './computed')).toEqual(['compare from ../../lib/parity']);
    });

    it('find a declaration of a name at any depth, and not a use of it', () => {
        expect(declarations('const result = { walk: await walk(page) };\nhead.walk.elements;\ninterface Pair { walk: Walk }', 'walk')).toBe(0);
        expect(declarations('function judge() {\n    const compare = () => [];\n}', 'compare')).toBe(1);
        expect(declarations('function judge() {\n    const { compare } = gates;\n}', 'compare')).toBe(1);
        expect(declarations('for (const [walk] of pairs) {}', 'walk')).toBe(1);
        expect(declarations('const a = 1, failures = [];', 'failures')).toBe(1);
        expect(declarations('pairs.map((compare) => compare);', 'compare')).toBe(1);
        expect(declarations('if (ready) {\n    function walk() {}\n}', 'walk')).toBe(1);
    });
});

describe("the Dark parity gate's helpers", () => {
    const all = sources();
    const gate = all.find((source) => source.file === GATE);

    it('scans the parity files', () => {
        expect(all.map((source) => source.file)).toEqual(expect.arrayContaining([HOME, COMPUTED, GATE]));
    });

    it.each(SYMBOLS)('define %s once, in test/helpers/parityWalk.ts', (name) => {
        const where = all.flatMap(({ file, text }) => Array.from({ length: definitions(text, name, file) }, () => file));
        expect(where).toEqual([HOME]);
    });

    it.each(SYMBOLS)('never name %s in an export list, so nothing can shadow the star export', (name) => {
        const where = all.filter(({ file, text }) => namedExports(text, name, file) > 0).map(({ file }) => file);
        expect(where).toEqual([]);
    });

    it('re-export them from e2e/themes/computed.ts with export * alone', () => {
        const computed = all.find((source) => source.file === COMPUTED);
        expect(code(computed?.text ?? '')).toBe("export * from '../../test/helpers/parityWalk';");
    });

    it('reach the gate from ./computed alone', () => {
        expect(takenElsewhere(gate?.text ?? '', GATE_NAMES, './computed', GATE)).toEqual([]);
        expect(gate?.text).toMatch(/from '\.\/computed'/);
    });

    it.each(SYMBOLS)('leave %s undeclared in the gate, at any depth, so nothing there shadows the import', (name) => {
        expect(declarations(gate?.text ?? '', name, GATE)).toBe(0);
    });
});
