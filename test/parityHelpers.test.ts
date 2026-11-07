// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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
const SHIFT_HOME = 'test/helpers/parityShift.ts';
const SYMBOLS = ['compare', 'walk', 'failures', 'FOLD_PAINT', 'PROPERTIES', 'GEOMETRY_SLACK', 'completeHiddenSegments'] as const;
/** The parity types, each an interface or a type in parityWalk.ts. Box isn't one: specs keep boxes of their own. */
const TYPES = ['Allowance', 'Walk', 'Walked', 'Comparison', 'WalkOptions', 'FoldedFocus', 'EvaluatingPage'] as const;
/** The shift's helpers, which parityWalk.ts's compare() imports from parityShift.ts. */
const SHIFT_SYMBOLS = ['checkShift', 'shiftLine', 'boxDelta'] as const;
/** Each guarded name and the one file that defines it. */
const HOMES: Record<string, string> = Object.fromEntries([...[...SYMBOLS, ...TYPES].map((name) => [name, HOME]), ...SHIFT_SYMBOLS.map((name) => [name, SHIFT_HOME])]);
/** The gate's helpers and the parity types, which the gate takes from ./computed alone. */
const GATE_NAMES = [...SYMBOLS, ...TYPES];

const parse = (source: string, file = 'fixture.ts') => {
    const kind = /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
};

/** The names a binding binds: a name, or each name a destructuring pattern holds, nested too. */
function boundNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

/** Every node under `node`, depth first. */
function nodes(node: ts.Node): ts.Node[] {
    const found: ts.Node[] = [];
    const visit = (child: ts.Node) => {
        found.push(child);
        ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
}

/**
 * Top-level definitions of `name` in `source`, exported or not, however indented: a function (a generator, a default
 * export; its overloads are one), each name a const, let or var binds (destructured, or one of several), a class, an
 * enum, an interface or a type alias. A declaration inside a function or a block isn't top level, and a string that
 * reads like one isn't code.
 */
function definitions(source: string, name: string, file?: string): number {
    let count = 0;
    let functions = 0;
    let bodies = 0;
    for (const statement of parse(source, file).statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
            functions += 1;
            if (statement.body) bodies += 1;
        } else if (ts.isVariableStatement(statement)) {
            count += statement.declarationList.declarations.flatMap((declaration) => boundNames(declaration.name)).filter((bound) => bound === name).length;
        } else if (
            (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
            statement.name?.text === name
        ) {
            count += 1;
        }
    }
    return count + (bodies > 0 ? bodies : functions > 0 ? 1 : 0);
}

/** Named exports of `name` in `source`: in an export list, by the name it exports, with or without `from`, and as `export * as`. */
function namedExports(source: string, name: string, file?: string): number {
    let count = 0;
    for (const statement of parse(source, file).statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
        if (ts.isNamespaceExport(statement.exportClause)) count += statement.exportClause.name.text === name ? 1 : 0;
        else count += statement.exportClause.elements.filter((element) => element.name.text === name).length;
    }
    return count;
}

/**
 * Where `source` takes any of `names` from, other than `allowed` under its own name: a static import (aliased either
 * way), a member of a namespace or default import, or what a dynamic import() or require() is destructured into.
 */
function takenElsewhere(source: string, names: readonly string[], allowed: string, file?: string): string[] {
    const watched = new Set(names);
    const offenders: string[] = [];
    const sourceFile = parse(source, file);
    const modules = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
        const from = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (clause.name) modules.set(clause.name.text, from);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) modules.set(bindings.name.text, from);
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const imported = (element.propertyName ?? element.name).text;
                const local = element.name.text;
                for (const name of new Set([imported, local])) {
                    if (watched.has(name) && (from !== allowed || imported !== local)) offenders.push(`${name} from ${from}`);
                }
            }
        }
    }
    for (const node of nodes(sourceFile)) {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && watched.has(node.name.text)) {
            const from = modules.get(node.expression.text);
            if (from !== undefined && from !== allowed) offenders.push(`${node.name.text} from ${from}`);
        }
        if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) continue;
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        if (!dynamic) continue;
        const from = node.arguments[0].text;
        let holder: ts.Node = node.parent;
        while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent;
        if (ts.isPropertyAccessExpression(holder) && watched.has(holder.name.text) && from !== allowed) offenders.push(`${holder.name.text} from ${from}`);
        if (ts.isVariableDeclaration(holder) && !ts.isIdentifier(holder.name) && from !== allowed) {
            offenders.push(...boundNames(holder.name).filter((name) => watched.has(name)).map((name) => `${name} from ${from}`));
        }
    }
    return offenders;
}

/** Declarations of `name` anywhere in `source`, at any depth: a binding, a parameter, a function, a class, a type. */
function declarations(source: string, name: string, file?: string): number {
    let count = 0;
    for (const node of nodes(parse(source, file))) {
        if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
            if (ts.isIdentifier(node.name) && node.name.text === name) count += 1;
        } else if (
            (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
            node.name?.text === name
        ) {
            count += 1;
        }
    }
    return count;
}

/**
 * Each `javascript` key in `source`: an object literal's property (as an allowance's `javascript: true`), computed
 * names too, a read of one (`allowance.javascript`, `allowance['javascript']`), one taken by destructuring
 * (`{ javascript }`, `{ javascript: js }`), and a member of an interface or type named Allowance. An
 * allowance says which routes it holds on with `routes`, so it can't hold on a route without JavaScript by accident.
 */
function javascriptKeys(source: string, file?: string): string[] {
    const found: string[] = [];
    const named = (name: ts.PropertyName | ts.Expression | undefined): boolean => {
        if (!name) return false;
        if (ts.isComputedPropertyName(name)) return named(name.expression);
        return (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && name.text === 'javascript';
    };
    const allowance = (node: ts.Node) => (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === 'Allowance';
    for (const node of nodes(parse(source, file))) {
        if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && named(node.name)) found.push('a javascript property');
        else if (ts.isPropertyAccessExpression(node) && node.name.text === 'javascript') found.push('a read of javascript');
        else if (ts.isElementAccessExpression(node) && named(node.argumentExpression)) found.push('a read of javascript');
        else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && named(node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined))) found.push('a javascript binding');
        else if (allowance(node)) {
            for (const member of nodes(node)) if (ts.isPropertySignature(member) && named(member.name)) found.push('Allowance.javascript');
        }
    }
    return found;
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

describe('the matchers for the parity types and the javascript key', () => {
    it('count an interface and a type alias as a top-level definition', () => {
        expect(definitions('export interface Walk {\n    elements: Walked[];\n}\n', 'Walk')).toBe(1);
        expect(definitions('export type Allowance = { page: string };\n', 'Allowance')).toBe(1);
        expect(definitions('function f() {\n    interface Walk { x: 1 }\n}\n', 'Walk')).toBe(0);
    });

    it('find a javascript property, a read of one, and a javascript member of Allowance', () => {
        expect(javascriptKeys("const VIEWER_ZOOM = [{ page: 'viewer', selector: 'img', javascript: true }];")).toEqual(['a javascript property']);
        expect(javascriptKeys("const z = [{ 'javascript': true }];")).toEqual(['a javascript property']);
        expect(javascriptKeys('allowances.filter((a) => !a.javascript || js);')).toEqual(['a read of javascript']);
        expect(javascriptKeys("allowances.filter((a) => a['javascript']);")).toEqual(['a read of javascript']);
        expect(javascriptKeys('export interface Allowance {\n    page: string;\n    /** Only with JavaScript. */\n    javascript?: true;\n}')).toEqual(['Allowance.javascript']);
        expect(javascriptKeys('export type Allowance = { routes?: readonly string[]; javascript?: boolean };')).toEqual(['Allowance.javascript']);
    });

    it('find a javascript key taken by destructuring, and one written as a computed name', () => {
        expect(javascriptKeys('const { javascript } = allowance;')).toEqual(['a javascript binding']);
        expect(javascriptKeys('allowances.filter(({ javascript: js }) => js);')).toEqual(['a javascript binding']);
        expect(javascriptKeys("const { 'javascript': js } = allowance;")).toEqual(['a javascript binding']);
        expect(javascriptKeys("const z = [{ ['javascript']: true }];")).toEqual(['a javascript property']);
        expect(javascriptKeys("export interface Allowance {\n    ['javascript']?: true;\n}")).toEqual(['Allowance.javascript']);
        expect(javascriptKeys('const { routes: javascript } = allowance;')).toEqual([]);
    });

    it('find none in routes, in a context option, or in prose', () => {
        expect(javascriptKeys("const z = [{ page: 'viewer', routes: SCRIPTED_ROUTES }];\nbrowser.newContext({ javaScriptEnabled: false });\n// javascript: true")).toEqual([]);
        expect(javascriptKeys("const why = 'only with javascript: true';")).toEqual([]);
    });
});

describe("the Dark parity gate's helpers", () => {
    const all = sources();
    const gate = all.find((source) => source.file === GATE);

    it('scans the parity files', () => {
        expect(all.map((source) => source.file)).toEqual(expect.arrayContaining([HOME, SHIFT_HOME, COMPUTED, GATE]));
    });

    it.each(Object.entries(HOMES))('define %s once, in %s', (name, home) => {
        const where = all.flatMap(({ file, text }) => Array.from({ length: definitions(text, name, file) }, () => file));
        expect(where).toEqual([home]);
    });

    it.each(Object.keys(HOMES))('never name %s in an export list, so nothing can shadow the star export', (name) => {
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

    it('hold no javascript key in the gate, nor in Allowance', () => {
        expect(javascriptKeys(gate?.text ?? '', GATE)).toEqual([]);
        expect(javascriptKeys(all.find((source) => source.file === HOME)?.text ?? '', HOME)).toEqual([]);
    });
});
