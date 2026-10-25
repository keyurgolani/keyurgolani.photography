/**
 * The route inventory for #14's curator boundary: every place a request can
 * change state, found by reading the source with the TypeScript parser.
 *
 * - A route handler exporting anything but GET or HEAD is a mutation.
 * - A `'use server'` directive, at the top of a file or of a function, makes
 *   server actions, which Next runs from a POST to any page.
 *
 * Both may live only under the curator prefixes, `app/curation/` and
 * `app/api/curation/`. There, every page, layout, template, route handler,
 * server action and generateMetadata must call requireCurator() as its first
 * statement, a mutation without `{ read: true }`, and every page and route
 * must be `force-dynamic`.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Where curator code lives, relative to the repository root. */
export const CURATOR_PREFIXES = ['app/curation/', 'app/api/curation/'];

/** The folders and files production code lives in. Tests, fixtures and build output don't count. */
const PRODUCTION_ROOTS = ['app', 'components', 'lib', 'utils', 'scripts', 'data', 'proxy.ts', 'instrumentation.ts'];

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(['__tests__', 'node_modules', '.next']);
const READ_METHODS = new Set(['GET', 'HEAD']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Next's route files under app/ that render or answer a request. */
const ROUTE_FILE = /^(page|layout|template|default|route)\.(?:ts|tsx|js|jsx|mjs)$/;

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

const isCurator = (file: string) => CURATOR_PREFIXES.some((prefix) => file.startsWith(prefix));

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
 * statement is anything else, an un-awaited call included.
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

const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Each exported value: its name (`default` for the default export) and, when it's a function written here, the function. */
function exportsOf(source: ts.SourceFile): { name: string; fn: FunctionLike | null; node: ts.Node }[] {
    const found: { name: string; fn: FunctionLike | null; node: ts.Node }[] = [];
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
            found.push({ name: isDefault(statement) ? 'default' : (statement.name?.text ?? 'default'), fn: statement, node: statement });
        } else if (ts.isVariableStatement(statement) && isExported(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                const init = declaration.initializer;
                const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
                found.push({ name: declaration.name.text, fn, node: declaration });
            }
        } else if (ts.isExportAssignment(statement)) {
            const value = statement.expression;
            const fn = ts.isIdentifier(value) ? (local.get(value.text) ?? null) : ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
            found.push({ name: 'default', fn, node: statement });
        } else if (ts.isExportDeclaration(statement)) {
            // A re-export hides where the function is written, so it can't be checked.
            const names = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((element) => element.name.text) : ['*'];
            for (const name of names) {
                const target = statement.moduleSpecifier ? null : (local.get(name) ?? null);
                found.push({ name, fn: target, node: statement });
            }
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

/** Reads the tree at `root` and lists its mutating entry points and the rules it breaks. */
export function routeInventory(root: string): Inventory {
    const inventory: Inventory = { handlers: [], actions: [], violations: [] };
    const files = PRODUCTION_ROOTS.flatMap((entry) => sourceFiles(root, entry)).sort();
    for (const file of files) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
        const curator = isCurator(file);
        const base = path.posix.basename(file);
        const isRouteFile = file.startsWith('app/') && ROUTE_FILE.test(base);

        // Server actions, file-level and inline.
        const fileLevel = hasDirective(source.statements, 'use server');
        const inline = inlineActions(source);
        if (fileLevel) inventory.actions.push(file);
        for (const fn of inline) inventory.actions.push(`${file}#${functionName(fn)}`);
        if ((fileLevel || inline.length > 0) && !curator) {
            inventory.violations.push(`${file} has a 'use server' directive outside ${CURATOR_PREFIXES.join(' and ')}.`);
        }
        if (fileLevel && curator) {
            for (const { name, fn } of exportsOf(source)) {
                if (!fn) inventory.violations.push(`${file} exports ${name} from a 'use server' file without writing the function there, so its guard can't be checked.`);
                else if (guardOf(fn.body) !== 'mutation') inventory.violations.push(`${file}#${name} is a server action whose first statement isn't await requireCurator().`);
            }
        }
        if (curator) {
            for (const fn of inline) {
                if (guardOf(fn.body) !== 'mutation') inventory.violations.push(`${file}#${functionName(fn)} is a server action whose first statement isn't await requireCurator().`);
            }
        }

        // Route handlers.
        if (file.startsWith('app/') && /^route\./.test(base)) {
            for (const { name, fn } of exportsOf(source)) {
                if (!HTTP_METHODS.has(name)) continue;
                inventory.handlers.push(`${file}#${name}`);
                const read = READ_METHODS.has(name);
                if (!read && !curator) inventory.violations.push(`${file} exports ${name}, a mutating handler outside ${CURATOR_PREFIXES.join(' and ')}.`);
                if (curator) {
                    const guard = fn ? guardOf(fn.body) : null;
                    if (guard === null || (!read && guard !== 'mutation')) {
                        inventory.violations.push(`${file}#${name} is a curator handler whose first statement isn't await requireCurator(${read ? '{ read: true }' : ''}).`);
                    }
                }
            }
        }

        // Curator pages, layouts and templates, and their metadata.
        if (curator && isRouteFile && !/^route\./.test(base)) {
            for (const { name, fn } of exportsOf(source)) {
                if (name !== 'default' && name !== 'generateMetadata') continue;
                if (!fn || guardOf(fn.body) === null) inventory.violations.push(`${file}#${name} renders curator content without await requireCurator() first.`);
            }
            if (!exportsOf(source).some(({ name }) => name === 'default')) inventory.violations.push(`${file} has no default export to guard.`);
        }
        if (curator && (base.startsWith('page.') || base.startsWith('route.')) && !isForceDynamic(source)) {
            inventory.violations.push(`${file} isn't force-dynamic.`);
        }
    }
    return inventory;
}
