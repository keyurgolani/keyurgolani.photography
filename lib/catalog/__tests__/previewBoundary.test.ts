// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * #16's containment, by import graph rather than by lint: no page, route
 * handler, or component outside the curator's folders, nor the proxy or the
 * server's register() hook, reaches the preview reader, which compiles
 * drafts, or any module under the preview's routes, by any import path. A
 * reached module that names a module some other way than a plain string,
 * or names the reader's process-wide cache, fails too, since the walk
 * can't follow that.
 */

const PREVIEW_READER = 'lib/catalog/preview-reader.ts';
const PUBLIC_READER = 'lib/catalog/public-reader.ts';
const PREVIEW_SUBTREE = 'app/curation/preview/';
const STATE_KEY_NAME = 'kg.catalog.previewReader';
const MODULE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Every module under `dir`, tests and the folders in `except` left out. */
function modules(dir: string, except: string[] = []): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
        .filter((file) => MODULE.test(file) && !/(?:^|\/)__tests__\//.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
        .filter((file) => !except.some((folder) => file.startsWith(folder)))
        .sort();
}

const PUBLIC_ENTRIES = [...modules('app', ['app/curation/']), ...modules('components', ['components/curation/']), 'proxy.ts', 'instrumentation.ts'];
const PREVIEW_ENTRIES = modules('app/curation/preview');

const forbidden = (file: string) => file === PREVIEW_READER || file.startsWith(PREVIEW_SUBTREE);

/** A string that names the preview reader or the preview's routes as a module, in any spelling the lint rule knows. */
const NAMES_PREVIEW = [
    /(^|\/)catalog(\/+\.)*\/+preview-reader(\.[cm]?[jt]sx?)?\/?([?#].*)?$/i,
    /(^|\/)curation(\/+\.)*\/+preview(\/|[?#]|$)/i,
];

const isPlainString = (node: ts.Node | undefined) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** A call that loads a module or reads a registered symbol: `import()`, `require()` and its members, `module.require()`, `Symbol.for()`. */
function loaderName(call: ts.CallExpression): string | null {
    const callee = call.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
    if (ts.isIdentifier(callee) && callee.text === 'require') return 'require()';
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const name = `${callee.expression.text}.${callee.name.text}`;
        if (callee.expression.text === 'require' || name === 'module.require' || name === 'Symbol.for') return `${name}()`;
    }
    return null;
}

/** What in `text` the walk can't follow, or that reaches the reader's cache without importing it. */
function unfollowable(text: string, fileName: string): string[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const loader = loaderName(node);
            if (loader !== null && !isPlainString(node.arguments[0])) found.push(`${loader} of a computed name`);
        }
        if (ts.isIdentifier(node) && node.text === 'createRequire') found.push('createRequire');
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
            if (node.text.includes(STATE_KEY_NAME)) found.push("the preview reader's cache key");
            if (NAMES_PREVIEW.some((name) => name.test(node.text))) found.push(`a string naming ${node.text}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

const scanned = new Map<string, string[]>();
function scan(file: string): string[] {
    if (!scanned.has(file)) scanned.set(file, unfollowable(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), file));
    return scanned.get(file) as string[];
}

/** Each reached module that's off limits or hides what it loads, with why. */
function violations(entry: string, source?: string): string[] {
    let files: string[];
    try {
        ({ files } = importGraph(entry, { source }));
    } catch (error) {
        // A name the walk can't resolve, such as the first part of a computed one.
        return [String(error instanceof Error ? error.message : error)];
    }
    return files.flatMap((file) => {
        if (forbidden(file)) return [`${file}: reached`];
        if (!MODULE.test(file) || file === PREVIEW_READER) return [];
        const reasons = file === entry && source !== undefined ? unfollowable(source, file) : scan(file);
        return reasons.map((reason) => `${file}: ${reason}`);
    });
}

describe("#16's preview reader boundary", { timeout: 120_000 }, () => {
    it('walks every public route, page, and component, the proxy, and the register() hook', () => {
        expect(PUBLIC_ENTRIES).toEqual(expect.arrayContaining(['app/page.tsx', 'app/work/page.tsx', 'app/api/photos/route.ts', 'components/home/HomeView.tsx', 'proxy.ts', 'instrumentation.ts']));
        expect(PUBLIC_ENTRIES.some((file) => file.startsWith('app/media/'))).toBe(true);
        expect(PUBLIC_ENTRIES.filter((file) => file.startsWith('app/curation/') || file.startsWith('components/curation/'))).toEqual([]);
    });

    it.each(PUBLIC_ENTRIES)('keeps %s from reaching the preview reader or the preview routes', (entry) => {
        expect(violations(entry)).toEqual([]);
    });

    it('would see a preview route reach the reader, so the walk follows it', () => {
        expect(importGraph('app/curation/preview/[draftId]/site/page.tsx').files).toContain(PREVIEW_READER);
    });

    it.each(PREVIEW_ENTRIES)('keeps %s, under the preview, from reaching the public reader', (entry) => {
        expect(importGraph(entry).files).not.toContain(PUBLIC_READER);
    });

    describe('catches a public module that', () => {
        const probe = 'app/work/page.tsx';
        it.each([
            ['imports the reader', 'lib/catalog/preview-reader.ts: reached', "import { previewDraftId } from '@/lib/catalog/preview-reader';\nexport const probe = previewDraftId;\n"],
            ['imports it through a path that walks back', 'lib/catalog/preview-reader.ts: reached', "import { previewDraftId } from '@/lib/catalog/projections/../preview-reader';\nexport const probe = previewDraftId;\n"],
            ['imports it with a query', 'lib/catalog/preview-reader.ts: reached', "import { previewDraftId } from '@/lib/catalog/preview-reader?probe';\nexport const probe = previewDraftId;\n"],
            ['imports it with a fragment', 'lib/catalog/preview-reader.ts: reached', "import { previewDraftId } from '@/lib/catalog/preview-reader#probe';\nexport const probe = previewDraftId;\n"],
            ['imports a preview module that imports it', 'app/curation/preview/preview.ts: reached', "import { previewMetadata } from '@/app/curation/preview/preview';\nexport const probe = previewMetadata;\n"],
            ['loads a module by a computed name', 'import() of a computed name', "const name = 'reader';\nexport const probe = () => import(`@/lib/catalog/preview-${name}`);\n"],
            ['loads a module by a cast name', 'import() of a computed name', "export const probe = () => import('@/lib/catalog/routes' as string);\n"],
            ['requires a module by a computed name', "doesn't resolve", "const name = 'reader';\nexport const probe = () => require('@/lib/catalog/preview-' + name);\n"],
            ['creates its own require', 'createRequire', "import { createRequire } from 'node:module';\nexport const probe = createRequire(import.meta.url);\n"],
            ['reads the cache by its key', "the preview reader's cache key", "export const probe = (globalThis as Record<symbol, unknown>)[Symbol.for('kg.catalog.previewReader')];\n"],
            ['reads a registered symbol by a computed key', 'Symbol.for() of a computed name', "const name = 'previewReader';\nexport const probe = (globalThis as Record<symbol, unknown>)[Symbol.for(`kg.catalog.${name}`)];\n"],
        ])('%s', (_, reason, source) => {
            expect(violations(probe, source).join('\n')).toContain(reason);
        });

        it('leaves plain imports, and Symbol.for() of a plain key, alone', () => {
            expect(violations(probe, "import { createRouteBuilder } from '@/lib/catalog/routes';\nexport const probe = [createRouteBuilder, Symbol.for('keyurgolani.photography.probe'), () => import('@/lib/catalog/reader')];\n")).toEqual([]);
        });
    });
});
