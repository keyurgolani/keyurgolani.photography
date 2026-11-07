// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './helpers/runTsx';

// The Dark parity gate's helpers have one home, test/helpers/parityWalk.ts, and e2e/themes/computed.ts only re-exports
// it with `export *`. A named re-export beside `export *` silently wins over it, so with a second copy the gate could
// run one compare() while the unit tests pin another. This reads the files as text and imports none of them, so it
// sees every copy, wherever it's defined.

const HOME = 'test/helpers/parityWalk.ts';
const COMPUTED = 'e2e/themes/computed.ts';
const SCANNED = ['test', 'e2e', '__tests__'];
const SYMBOLS = ['compare', 'walk', 'failures', 'FOLD_PAINT', 'PROPERTIES', 'GEOMETRY_SLACK', 'completeHiddenSegments'] as const;

/** Top-level definitions of `name` in `source`, exported or not: a local one inside a function is indented. */
function definitions(source: string, name: string): number {
    const pattern = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`, 'gm');
    return source.match(pattern)?.length ?? 0;
}

/** Named exports of `name` in `source`, as `export { … }` with or without `from`, by the name they export. */
function namedExports(source: string, name: string): number {
    let count = 0;
    for (const [, list] of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
        for (const item of list.split(',')) {
            const exported = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim();
            if (exported === name) count += 1;
        }
    }
    return count;
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

describe("the matchers this check counts with", () => {
    it('count a top-level definition, exported or not, and not a local one', () => {
        expect(definitions('export function compare(base: Walk) {}\n', 'compare')).toBe(1);
        expect(definitions('export const failures = (c: Comparison) => [];\n', 'failures')).toBe(1);
        expect(definitions('const GEOMETRY_SLACK = 0;\nexport const PROPERTIES = [];\n', 'GEOMETRY_SLACK')).toBe(1);
        expect(definitions('function walk() {\n    const walk = () => 1;\n}\n', 'walk')).toBe(1);
        expect(definitions('    const compare = (a: string, b: string) => 0;\n', 'compare')).toBe(0);
        expect(definitions('export const compareAll = 1;\n', 'compare')).toBe(0);
    });

    it('count a named export, on one line or several, typed or renamed, and not a star export', () => {
        expect(namedExports("export { GEOMETRY_SLACK, compare, type Walk } from './parityCompare';", 'compare')).toBe(1);
        expect(namedExports("export {\n    failures,\n    walk as walked,\n} from './other';", 'failures')).toBe(1);
        expect(namedExports("export { compare as walk } from './other';", 'walk')).toBe(1);
        expect(namedExports("export type { Walk } from './other';\nexport { compare };", 'compare')).toBe(1);
        expect(namedExports("export * from './parityWalk';", 'compare')).toBe(0);
    });
});

describe("the Dark parity gate's helpers", () => {
    const all = sources();

    it('scans the parity files', () => {
        expect(all.map((source) => source.file)).toEqual(expect.arrayContaining([HOME, COMPUTED, 'e2e/themes/dark-parity.spec.ts']));
    });

    it.each(SYMBOLS)('define %s once, in test/helpers/parityWalk.ts', (name) => {
        const where = all.flatMap(({ file, text }) => Array.from({ length: definitions(text, name) }, () => file));
        expect(where).toEqual([HOME]);
    });

    it.each(SYMBOLS)('never name %s in an export list, so nothing can shadow the star export', (name) => {
        const where = all.filter(({ text }) => namedExports(text, name) > 0).map(({ file }) => file);
        expect(where).toEqual([]);
    });

    it('re-export them from e2e/themes/computed.ts with export * alone', () => {
        const computed = all.find((source) => source.file === COMPUTED);
        expect(code(computed?.text ?? '')).toBe("export * from '../../test/helpers/parityWalk';");
    });
});
