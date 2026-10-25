// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

// Every module a 'use client' file reaches ships to visitors. The reader and
// the projections import lib/media/url.ts, which pulls in node:crypto through
// lib/identity/ids.ts, so client code takes only types from them (#3), and
// any module it imports at runtime must not reach them either. Server
// components may import them freely. reader.ts and projections/work.ts carry
// server-only, so a client bundle that reaches them also fails the build;
// this walk keeps the rule for the modules that don't, and checks the other
// direction too: nothing loaded under plain Node, where server-only throws,
// reaches a module that imports it.

const GUARDED = /^lib\/catalog\/(reader|public-reader|projections\/[^/]+)$/;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const CLIENT_ROOTS = ['app', 'components'];

/** The text of a repo-relative file, or undefined when there is none. */
type Read = (file: string) => string | undefined;

const disk: Read = (file) => {
    const full = path.join(REPO_ROOT, file);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : undefined;
};

/** `files` over the repository, for synthetic modules at paths inside it. */
const overlay = (files: Record<string, string>): Read => (file) => files[file] ?? disk(file);

function parse(file: string, source: string): ts.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Whether `source` opens with a 'use client' directive, after any comments and other directives. */
function isClientModule(file: string, source: string): boolean {
    for (const statement of parse(file, source).statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
        if (statement.expression.text === 'use client') return true;
    }
    return false;
}

/** `import type ...`, or a named list where every specifier is marked `type`. A bare `import 'x'` runs `x`. */
function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return false;
    const { elements } = clause.namedBindings;
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/** `export type { ... } from`, or a named list where every specifier is marked `type`. `export *` re-exports values. */
function exportIsTypeOnly(declaration: ts.ExportDeclaration): boolean {
    if (declaration.isTypeOnly) return true;
    const clause = declaration.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return false;
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** Every specifier `source` loads at runtime: static imports and re-exports, `import()` (next/dynamic's too), and `require()`. */
function runtimeSpecifiers(file: string, source: string): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            if (!importIsTypeOnly(node.importClause)) found.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (!exportIsTypeOnly(node)) found.push(node.moduleSpecifier.text);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
            if (!node.isTypeOnly) found.push(node.moduleReference.expression.text);
        } else if (ts.isCallExpression(node)) {
            const [argument] = node.arguments;
            const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
            if (loads && argument && ts.isStringLiteralLike(argument)) found.push(argument.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(parse(file, source));
    return found;
}

/** The repo-relative source file `specifier` names from `file`, or null for a package, a built-in, or a stylesheet. */
function resolve(file: string, specifier: string, read: Read): string | null {
    let base: string;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    else return null;
    const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
    const candidates = [base, ...EXTENSIONS.map((extension) => `${stem}${extension}`), ...EXTENSIONS.map((extension) => `${base}/index${extension}`)];
    const resolved = candidates.find((candidate) => SOURCE.test(candidate) && read(candidate) !== undefined);
    if (resolved) return resolved;
    if (read(base) !== undefined) return null;
    throw new Error(`${file} imports ${specifier}, which doesn't resolve to a file.`);
}

/**
 * Walks the runtime imports from each entry and returns, as `a -> b -> c`, the
 * first chain to each module `stop` flags. It doesn't walk past a flagged module.
 */
function reaching(entries: string[], read: Read, stop: (file: string, source: string) => boolean): string[] {
    const chains: string[] = [];
    for (const entry of entries) {
        const seen = new Set([entry]);
        const queue = [[entry]];
        while (queue.length > 0) {
            const chain = queue.shift() as string[];
            const file = chain[chain.length - 1];
            const source = read(file) ?? '';
            if (chain.length > 1 && stop(file, source)) {
                chains.push(chain.join(' -> '));
                continue;
            }
            for (const specifier of runtimeSpecifiers(file, source)) {
                const next = resolve(file, specifier, read);
                if (next === null || seen.has(next)) continue;
                seen.add(next);
                queue.push([...chain, next]);
            }
        }
    }
    return chains;
}

const isGuarded = (file: string) => GUARDED.test(file.replace(SOURCE, ''));
const importsServerOnly = (file: string, source: string) => runtimeSpecifiers(file, source).includes('server-only');

/** The chains from each 'use client' module in `files` to the reader, the public reader, or a projection. */
function clientLeaks(files: string[], read: Read = disk): string[] {
    const clients = files.filter((file) => isClientModule(file, read(file) ?? ''));
    return reaching(clients, read, isGuarded);
}

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        const relative = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...sourceFiles(relative));
        } else if (SOURCE.test(entry.name)) {
            out.push(relative);
        }
    }
    return out;
}

const PROBE = 'components/work/Probe.tsx';
const HELPER = 'components/work/probeHelper.ts';

describe('client modules and the catalog read path', () => {
    const files = CLIENT_ROOTS.flatMap(sourceFiles);
    const clients = files.filter((file) => isClientModule(file, disk(file) ?? ''));

    it('finds the client modules under app/ and components/, WorkCoverImage among them', () => {
        expect(clients).toEqual(expect.arrayContaining(['components/work/WorkCoverImage.tsx', 'components/site/SiteNav.tsx', 'app/error.tsx']));
        expect(clients).not.toContain('components/work/SeriesCatalog.tsx');
    });

    it('take only types from the reader and the projections, directly or through any module they import', () => {
        expect(clientLeaks(files)).toEqual([]);
    });

    it('covers a client module that takes types from them, as WorkCoverImage does', () => {
        const source = disk('components/work/WorkCoverImage.tsx') ?? '';
        expect(source).toContain("import type { WorkCover } from '@/lib/catalog/projections/work';");
        expect(runtimeSpecifiers('components/work/WorkCoverImage.tsx', source)).not.toContain('@/lib/catalog/projections/work');
    });

    it.each([
        ["'use client';\nimport { workRouteOf } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport { type WorkCover, workRouteOf } from '../../lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport WorkDefault, { type WorkCover } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport * as work from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport { createRouteBuilder } from '@/lib/catalog/reader';\n", 1],
        ["'use client';\nimport { createRouteBuilder } from '@/lib/catalog/reader.ts';\n", 1],
        ["'use client';\nexport { publicRoutes } from '@/lib/catalog/public-reader';\n", 1],
        ["'use client';\nexport * from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nexport * as work from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nexport { type WorkCover, workRouteOf } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport '@/lib/catalog/projections/work';\n", 1],
        ["// A note first.\n'use client';\nimport { LEGACY_GALLERY_PATH } from '@/lib/catalog/projections/work';\n", 1],
        ['"use client";\nimport { LEGACY_GALLERY_PATH } from "@/lib/catalog/projections/work";\n', 1],
        ["'use client'; import { workRouteOf } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nexport async function load() {\n    return import('@/lib/catalog/projections/work');\n}\n", 1],
        ["'use client';\nimport dynamic from 'next/dynamic';\nexport const Lazy = dynamic(() => import('@/lib/catalog/reader'));\n", 1],
        ["'use client';\nconst work = require('@/lib/catalog/projections/work');\nexport default work;\n", 1],
        ["'use client';\nimport work = require('@/lib/catalog/projections/work');\nexport default work;\n", 1],
        ["'use client';\nimport type { WorkCover } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nimport { type WorkCover, type WorkCatalog } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nexport type { WorkCover } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nexport { type WorkCover } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nexport type WorkProbe = import('@/lib/catalog/projections/work').WorkCover;\n", 0],
        ["'use client';\nimport { VARIANT_WIDTHS } from '@/lib/identity/variants';\n", 0],
        ["'use client';\nimport { photoCountLabel } from '@/lib/catalog/labels';\n", 0],
        ["import { workRouteOf } from '@/lib/catalog/projections/work';\n", 0],
        ["import { workRouteOf } from '@/lib/catalog/projections/work';\n'use client';\n", 0],
    ] as const)('flags %j %d times', (source, count) => {
        expect(clientLeaks([PROBE], overlay({ [PROBE]: source }))).toHaveLength(count);
    });

    it('follows a client module through a module with no directive, and names the chain', () => {
        const read = overlay({
            [PROBE]: "'use client';\nimport { label } from './probeHelper';\nexport const probe = label;\n",
            [HELPER]: "import { workRouteOf } from '@/lib/catalog/projections/work';\nexport const label = workRouteOf;\n",
        });
        expect(clientLeaks([PROBE], read)).toEqual([`${PROBE} -> ${HELPER} -> lib/catalog/projections/work.ts`]);
    });

    it('follows two modules deep, through a dynamic import, and stops at a cycle', () => {
        const NEXT = 'components/work/probeNext.ts';
        const read = overlay({
            [PROBE]: "'use client';\nexport const probe = () => import('./probeHelper');\n",
            [HELPER]: "export * from './probeNext';\nexport { probe } from './Probe';\n",
            [NEXT]: "const reader = require('../../lib/catalog/reader');\nexport default reader;\n",
        });
        expect(clientLeaks([PROBE], read)).toEqual([`${PROBE} -> ${HELPER} -> ${NEXT} -> lib/catalog/reader.ts`]);
    });

    it('lets a module with no directive reach them, and a client module reach it through types only', () => {
        const read = overlay({
            [PROBE]: "'use client';\nimport type { Label } from './probeHelper';\nexport type Probe = Label;\n",
            [HELPER]: "import { workRouteOf } from '@/lib/catalog/projections/work';\nexport type Label = typeof workRouteOf;\n",
        });
        expect(clientLeaks([PROBE, HELPER], read)).toEqual([]);
    });
});

describe('plain Node and server-only', () => {
    // Loaded with Node's default conditions, where server-only throws: the
    // CLI and watcher scripts (and their esbuild bundles), the Playwright
    // specs and config, and the smoke tests' fixture publisher.
    const entries = [...sourceFiles('scripts'), ...sourceFiles('e2e'), 'playwright.config.ts', 'ci/publish-fixture.ts', 'lib/catalog/testing.ts'];

    it('finds the reader and the Work projection carrying server-only', () => {
        for (const file of ['lib/catalog/reader.ts', 'lib/catalog/projections/work.ts', 'lib/catalog/public-reader.ts']) {
            expect(importsServerOnly(file, disk(file) ?? '')).toBe(true);
        }
        expect(entries).toEqual(expect.arrayContaining(['scripts/photos.ts', 'e2e/work.spec.ts', 'e2e/support/catalogServer.ts']));
    });

    it('never reaches a module that imports it', () => {
        expect(reaching(entries, disk, importsServerOnly)).toEqual([]);
    });

    it('catches an entry that reaches one through the test catalog', () => {
        const SCRIPT = 'scripts/probe.ts';
        const TESTING = 'lib/catalog/testing.ts';
        const read = overlay({
            [SCRIPT]: "import { createTestCatalog } from '../lib/catalog/testing';\nexport const probe = createTestCatalog;\n",
            [TESTING]: `import { createCatalogReader } from './reader';\n${disk(TESTING)}`,
        });
        expect(reaching([SCRIPT], read, importsServerOnly)).toEqual([`${SCRIPT} -> ${TESTING} -> lib/catalog/reader.ts`]);
    });
});
