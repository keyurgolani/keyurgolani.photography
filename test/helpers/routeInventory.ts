/**
 * The route inventory for #14's curator boundary: every place a request can
 * change state or read curator data, found by reading the source with the
 * TypeScript parser.
 *
 * - A route handler exporting anything but GET or HEAD is a mutation.
 * - A `'use server'` directive, at the top of a file or of a function, makes
 *   server actions, which Next runs from a POST to any page.
 *
 * What counts as curator code is decided by URL, the way Next serves it:
 * route groups `(name)` and parallel slots `@name` drop out of the path, so
 * any `app/` file whose URL is under `/curation` or `/api/curation` is
 * curator code, whatever folder holds it. Mutations may live only there.
 * There, every page, layout, template, default, route handler, metadata
 * route (share images, icons, sitemap, robots, manifest), server action,
 * generateMetadata and generateViewport must call requireCurator(), imported
 * from `@/lib/curation/auth`, as its first statement, a mutation without
 * `{ read: true }`. Pages, handlers and metadata routes must be
 * `force-dynamic`. The fallback files (not-found, loading, error,
 * global-error, forbidden, unauthorized) either call it too or import no
 * data. No file outside curator code may import a curator action module.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isCuratorPath } from '../../lib/curation/auth/policy';

/** The URL prefixes curator code serves. */
export const CURATOR_URLS = ['/curation', '/api/curation'];

/** The folders and files production code lives in. Tests, fixtures and build output don't count. */
const PRODUCTION_ROOTS = ['app', 'components', 'lib', 'utils', 'scripts', 'data', 'proxy.ts', 'instrumentation.ts'];

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIPPED_DIRS = new Set(['__tests__', 'node_modules', '.next']);
const READ_METHODS = new Set(['GET', 'HEAD']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Next's file conventions under app/, by the file's name without its extension. */
type Convention = 'render' | 'fallback' | 'client-fallback' | 'metadata' | 'route';

function conventionOf(file: string): Convention | null {
    if (!file.startsWith('app/') || !/\.(?:ts|tsx|js|jsx|mjs)$/.test(file)) return null;
    const name = path.posix.basename(file).replace(/\.[^.]+$/, '');
    if (['page', 'layout', 'template', 'default'].includes(name)) return 'render';
    if (['not-found', 'loading', 'forbidden', 'unauthorized'].includes(name)) return 'fallback';
    if (['error', 'global-error'].includes(name)) return 'client-fallback';
    if (/^(?:opengraph-image|twitter-image|icon|apple-icon)\d*$/.test(name) || ['sitemap', 'robots', 'manifest'].includes(name)) return 'metadata';
    if (name === 'route') return 'route';
    return null;
}

/** Exports Next calls while rendering a page or layout, which must be guarded too. */
const RENDER_EXPORTS = new Set(['default', 'generateMetadata', 'generateViewport']);
/** Exports Next calls to answer a metadata route. */
const METADATA_EXPORTS = new Set(['default', 'generateImageMetadata', 'generateSitemaps']);
/** What a fallback file may import without calling requireCurator(): UI only, no data. */
const FALLBACK_IMPORTS = new Set(['react', 'next', 'next/link', 'next/image', 'next/navigation']);

export interface Inventory {
    /** Route handler methods: `file#METHOD`. */
    handlers: string[];
    /** Files with a `'use server'` directive, and where: `file` for the whole file, `file#name` for one function. */
    actions: string[];
    /** Every rule the tree breaks, one sentence each. Empty when it keeps them all. */
    violations: string[];
}

function sourceFiles(root: string, entry: string): string[] {
    const full = path.join(root, entry);
    if (!fs.existsSync(full)) return [];
    if (fs.statSync(full).isFile()) return SOURCE.test(entry) ? [entry] : [];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((dirent) => {
        if (dirent.isDirectory() && SKIPPED_DIRS.has(dirent.name)) return [];
        if (/\.test\.[cm]?[jt]sx?$/.test(dirent.name)) return [];
        return sourceFiles(root, path.posix.join(entry, dirent.name));
    });
}

/**
 * The URL segments an `app/` file's folder serves: route groups and
 * parallel slots dropped, intercepting markers such as `(..)` stripped.
 * Null for a file outside app/.
 */
export function urlSegments(file: string): string[] | null {
    if (!file.startsWith('app/')) return null;
    const folders = path.posix.dirname(file).split('/').slice(1);
    const segments: string[] = [];
    for (const folder of folders) {
        if (folder.startsWith('@')) continue;
        if (/^\([^.)][^)]*\)$/.test(folder)) continue;
        const name = folder.replace(/^(?:\(\.{1,3}\))+/, '');
        if (name) segments.push(name);
    }
    return segments;
}

/** Whether an `app/` file serves, or lives under, a curator URL. */
export function isCuratorFile(file: string): boolean {
    const segments = urlSegments(file);
    return segments !== null && isCuratorPath(`/${segments.join('/')}`);
}

const isDynamic = (segment: string | undefined) => segment !== undefined && segment.startsWith('[');

/** Whether a route file's URL starts with a dynamic segment where a curator path could match it: `/[x]` or `/api/[x]`. */
function canServeCuratorPaths(file: string): boolean {
    const segments = urlSegments(file);
    if (!segments) return false;
    return isDynamic(segments[0]) || (segments[0] === 'api' && isDynamic(segments[1]));
}

function hasDirective(statements: ts.NodeArray<ts.Statement>, directive: string): boolean {
    for (const statement of statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
        if (statement.expression.text === directive) return true;
    }
    return false;
}

/** The statements after a body's directive prologue. */
function bodyAfterDirectives(statements: ts.NodeArray<ts.Statement>): ts.Statement[] {
    let i = 0;
    while (i < statements.length) {
        const statement = statements[i];
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
        i++;
    }
    return statements.slice(i);
}

/**
 * How a body's first statement calls requireCurator(): `mutation` for a call
 * without `{ read: true }`, `read` for one with it, or null when the first
 * statement is anything else, an un-awaited call included. Where the name
 * comes from is checkedImport()'s job.
 */
function guardOf(body: ts.ConciseBody | undefined): 'mutation' | 'read' | null {
    if (!body || !ts.isBlock(body)) return null;
    const [first] = bodyAfterDirectives(body.statements);
    if (!first) return null;
    let expression: ts.Expression | undefined;
    if (ts.isExpressionStatement(first)) expression = first.expression;
    else if (ts.isVariableStatement(first) && first.declarationList.declarations.length === 1) expression = first.declarationList.declarations[0].initializer;
    if (!expression || !ts.isAwaitExpression(expression)) return null;
    const call = expression.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'requireCurator') return null;
    const [options] = call.arguments;
    if (!options) return 'mutation';
    if (!ts.isObjectLiteralExpression(options) || call.arguments.length !== 1) return null;
    const read = options.properties.find((property) => property.name && ts.isIdentifier(property.name) && property.name.text === 'read');
    if (!read) return options.properties.length === 0 ? 'mutation' : null;
    if (options.properties.length !== 1 || !ts.isPropertyAssignment(read)) return null;
    return read.initializer.kind === ts.SyntaxKind.TrueKeyword ? 'read' : null;
}

/** The repository file a relative or `@/` specifier names, or null for a package, a built-in, or one that doesn't resolve. */
function resolveLocal(root: string, from: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith('@/')) base = path.join(root, specifier.slice(2));
    else if (specifier.startsWith('.')) base = path.resolve(path.join(root, path.dirname(from)), specifier);
    else return null;
    const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
    const candidates = [base, ...EXTENSIONS.map((extension) => `${stem}${extension}`), ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`))];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return found ? path.relative(root, found).split(path.sep).join('/') : null;
}

/** Whether a specifier names `lib/curation/auth`, by the alias or a relative path, whether or not the file exists in this tree. */
function namesAuthModule(root: string, from: string, specifier: string): boolean {
    let target: string;
    if (specifier.startsWith('@/')) target = specifier.slice(2);
    else if (specifier.startsWith('.')) target = path.relative(root, path.resolve(path.join(root, path.dirname(from)), specifier)).split(path.sep).join('/');
    else return false;
    return /^lib\/curation\/auth(?:\/index(?:\.[cm]?[jt]sx?)?)?$/.test(target);
}

/** Whether `requireCurator` in this file is the real one: a named import, unrenamed, from lib/curation/auth, and nothing local by that name. */
function importsRealGuard(root: string, file: string, source: ts.SourceFile): boolean {
    let imported = false;
    let local = false;
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const bindings = statement.importClause?.namedBindings;
            if (statement.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
            for (const element of bindings.elements) {
                if (element.name.text !== 'requireCurator') continue;
                const unrenamed = !element.propertyName || element.propertyName.text === 'requireCurator';
                if (unrenamed && !element.isTypeOnly && namesAuthModule(root, file, statement.moduleSpecifier.text)) imported = true;
                else local = true;
            }
        } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'requireCurator') {
            local = true;
        } else if (ts.isVariableStatement(statement)) {
            if (statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'requireCurator')) local = true;
        } else if (ts.isImportEqualsDeclaration(statement) && statement.name.text === 'requireCurator') {
            local = true;
        }
    }
    return imported && !local;
}

const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Each exported value: its name (`default` for the default export) and, when it's a function written here, the function. */
function exportsOf(source: ts.SourceFile): { name: string; fn: FunctionLike | null }[] {
    const found: { name: string; fn: FunctionLike | null }[] = [];
    const local = new Map<string, FunctionLike>();
    for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) local.set(statement.name.text, statement);
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                const init = declaration.initializer;
                if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) local.set(declaration.name.text, init);
            }
        }
    }
    for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
            found.push({ name: isDefault(statement) ? 'default' : (statement.name?.text ?? 'default'), fn: statement });
        } else if (ts.isVariableStatement(statement) && isExported(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                const init = declaration.initializer;
                const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
                found.push({ name: declaration.name.text, fn });
            }
        } else if (ts.isExportAssignment(statement)) {
            const value = statement.expression;
            const fn = ts.isIdentifier(value) ? (local.get(value.text) ?? null) : ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
            found.push({ name: 'default', fn });
        } else if (ts.isExportDeclaration(statement)) {
            // A re-export hides where the function is written, so it can't be checked.
            const names = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((element) => element.name.text) : ['*'];
            for (const name of names) found.push({ name, fn: statement.moduleSpecifier ? null : (local.get(name) ?? null) });
        }
    }
    return found;
}

/** Whether the module exports `dynamic = 'force-dynamic'`. */
function isForceDynamic(source: ts.SourceFile): boolean {
    return source.statements.some(
        (statement) =>
            ts.isVariableStatement(statement) &&
            isExported(statement) &&
            statement.declarationList.declarations.some(
                (declaration) =>
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === 'dynamic' &&
                    declaration.initializer !== undefined &&
                    ts.isStringLiteral(declaration.initializer) &&
                    declaration.initializer.text === 'force-dynamic',
            ),
    );
}

/** Every function in `source` whose body opens with `'use server'`. */
function inlineActions(source: ts.SourceFile): FunctionLike[] {
    const found: FunctionLike[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body && ts.isBlock(node.body)) {
            if (hasDirective(node.body.statements, 'use server')) found.push(node);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
}

function functionName(fn: FunctionLike): string {
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
    if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
    return '<anonymous>';
}

/** The value imports of a module, type-only ones left out, with their specifiers. */
function valueImports(source: ts.SourceFile): string[] {
    const specifiers: string[] = [];
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
            specifiers.push(statement.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
            specifiers.push(statement.moduleSpecifier.text);
        }
    }
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
            const [argument] = node.arguments;
            specifiers.push(argument && ts.isStringLiteralLike(argument) ? argument.text : '<computed>');
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return specifiers;
}

const fallbackMayImport = (specifier: string) => FALLBACK_IMPORTS.has(specifier) || specifier.endsWith('.css') || specifier.startsWith('@/components/');

/** Reads the tree at `root` and lists its mutating entry points and the rules it breaks. */
export function routeInventory(root: string): Inventory {
    const inventory: Inventory = { handlers: [], actions: [], violations: [] };
    const files = PRODUCTION_ROOTS.flatMap((entry) => sourceFiles(root, entry)).sort();
    const parsed = new Map<string, ts.SourceFile>();
    for (const file of files) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        parsed.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind));
    }
    const curatorActionFiles = new Set<string>();
    const where = CURATOR_URLS.join(' and ');

    for (const file of files) {
        const source = parsed.get(file)!;
        const curator = isCuratorFile(file);
        const convention = conventionOf(file);
        /** Whether something in this file had to call requireCurator() and does. */
        let guarded = false;
        const need = (fn: FunctionLike | null, kind: 'read' | 'mutation'): boolean => {
            const guard = fn ? guardOf(fn.body) : null;
            if (guard !== null) guarded = true;
            return kind === 'read' ? guard !== null : guard === 'mutation';
        };

        // Server actions, file-level and inline.
        const fileLevel = hasDirective(source.statements, 'use server');
        const inline = inlineActions(source);
        if (fileLevel) inventory.actions.push(file);
        for (const fn of inline) inventory.actions.push(`${file}#${functionName(fn)}`);
        if ((fileLevel || inline.length > 0) && !curator) {
            inventory.violations.push(`${file} has a 'use server' directive outside ${where}.`);
        }
        if (fileLevel && curator) {
            curatorActionFiles.add(file);
            for (const { name, fn } of exportsOf(source)) {
                if (!fn) inventory.violations.push(`${file} exports ${name} from a 'use server' file without writing the function there, so its guard can't be checked.`);
                else if (!need(fn, 'mutation')) inventory.violations.push(`${file}#${name} is a server action whose first statement isn't await requireCurator().`);
            }
        }
        if (curator) {
            for (const fn of inline) {
                if (!need(fn, 'mutation')) inventory.violations.push(`${file}#${functionName(fn)} is a server action whose first statement isn't await requireCurator().`);
            }
        }

        if (convention !== null && !curator && canServeCuratorPaths(file)) {
            inventory.violations.push(`${file} starts with a dynamic segment, so it can serve curator paths. Give it a static parent.`);
        }

        // Route handlers.
        if (convention === 'route') {
            for (const { name, fn } of exportsOf(source)) {
                if (!HTTP_METHODS.has(name)) continue;
                inventory.handlers.push(`${file}#${name}`);
                const read = READ_METHODS.has(name);
                if (!read && !curator) inventory.violations.push(`${file} exports ${name}, a mutating handler outside ${where}.`);
                if (curator && !need(fn, read ? 'read' : 'mutation')) {
                    inventory.violations.push(`${file}#${name} is a curator handler whose first statement isn't await requireCurator(${read ? '{ read: true }' : ''}).`);
                }
            }
        }

        if (curator && (convention === 'render' || convention === 'metadata')) {
            const guardedExports = convention === 'render' ? RENDER_EXPORTS : METADATA_EXPORTS;
            const exported = exportsOf(source);
            for (const { name, fn } of exported) {
                if (guardedExports.has(name) && !need(fn, 'read')) inventory.violations.push(`${file}#${name} renders curator content without await requireCurator() first.`);
                if (name === 'generateStaticParams') inventory.violations.push(`${file} exports generateStaticParams, which renders curator pages at build time.`);
            }
            if (!exported.some(({ name }) => name === 'default')) inventory.violations.push(`${file} has no default export to guard.`);
        }

        if (curator && (convention === 'fallback' || convention === 'client-fallback')) {
            if (convention === 'client-fallback' && !hasDirective(source.statements, 'use client')) {
                inventory.violations.push(`${file} must be a 'use client' component, as Next requires of an error boundary.`);
            }
            const fallbackGuarded = convention === 'fallback' && exportsOf(source).some(({ name, fn }) => name === 'default' && need(fn, 'read'));
            if (!fallbackGuarded) {
                const data = valueImports(source).filter((specifier) => !fallbackMayImport(specifier));
                if (data.length > 0) {
                    inventory.violations.push(`${file} is a curator fallback that imports ${data.join(', ')}. It may import only UI, or call await requireCurator() first.`);
                }
            }
        }

        if (curator && (convention === 'render' || convention === 'route' || convention === 'metadata')) {
            const base = path.posix.basename(file);
            if ((base.startsWith('page.') || convention !== 'render') && !isForceDynamic(source)) inventory.violations.push(`${file} isn't force-dynamic.`);
        }

        if (guarded && !importsRealGuard(root, file, source)) {
            inventory.violations.push(`${file} calls requireCurator() without importing it, unrenamed, from @/lib/curation/auth.`);
        }
    }

    // No public code may import a curator action module.
    for (const file of files) {
        if (isCuratorFile(file)) continue;
        for (const specifier of valueImports(parsed.get(file)!)) {
            const target = resolveLocal(root, file, specifier);
            if (target !== null && curatorActionFiles.has(target)) {
                inventory.violations.push(`${file} imports a curator action from ${target}.`);
            }
        }
    }
    return inventory;
}
