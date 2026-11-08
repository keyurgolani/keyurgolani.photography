/**
 * The delete-call rail (#181's A10 review): every call in the source tree
 * that can delete a file or a folder, with the file and the named function
 * it sits in, so a test can hold them to an allowlist. It reads the source
 * with the TypeScript parser and runs nothing. It fails closed: a form it
 * can't resolve is a finding too, and only the allowlist gets one past.
 *
 * It finds:
 *   - `rm`, `rmSync`, `rmdir`, `unlink`, `rimraf`, `remove`, `emptyDir`,
 *     `mkdtempDisposable` and their kin however they're reached: called
 *     (named by the whole call, its target and options included, whitespace
 *     normalised, item 52), passed on, imported, destructured, or by a
 *     literal key;
 *   - any import, re-export, `require()`, `import()`,
 *     `process.getBuiltinModule()`, `module.require()` or `createRequire()`
 *     load of `rimraf`, `del`, `fs-extra` or `trash`, or a subpath of one;
 *   - every child_process call, however child_process is reached (#181's A10
 *     review, items 39 and 43): it reads no command line, so a process call
 *     is a finding whatever it runs, named by the whole call, arguments and
 *     options included, whitespace normalised, and only an allowlist entry
 *     with that exact text gets it past;
 *   - all dynamic code and native loading (items 39 and 48): `eval` in any
 *     form, `Function` called, constructed or read as a member, any
 *     `.constructor(…)` call, any Worker however it's bound, any load of
 *     `node:vm`, `node:module`, `cluster`, `inspector`, `repl`, `wasi` or
 *     `worker_threads`, and a member named `binding`, `_linkedBinding`,
 *     `dlopen`, `execve`, `getBuiltinModule`, `createRequire` or `_load` on
 *     any object;
 *   - and, failing closed: `require()` or `import()` of a name that isn't a
 *     literal; computed access or destructuring on fs or child_process, or
 *     on the global object or a member chain ending in one; a variable given
 *     the global object, and every member read on it; `process` used other
 *     than by a member or `typeof`, so aliased, destructured, passed or
 *     assigned; and any other use of an fs or child_process module object,
 *     or `fs.promises`, than `.name` access or destructuring with literal
 *     keys, such as passing, assigning, spreading or exporting it, or
 *     `.then()` on its `import()`.
 *
 * It scans every source file in the repository, tracked or new, but what
 * RAIL_EXCLUSIONS leaves out, each rule with its reason: tests, Playwright's
 * config, the files in e2e/, ci/ and test/ that need it, each by name, and
 * the git-ignored node_modules/ and .next/. Any other file in e2e/, ci/ or
 * test/ is scanned. Overwriting renames and copies onto existing paths are
 * out of its scope.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './runTsx';

export interface DeleteCall {
    /** Relative to the repository root, with `/`. */
    file: string;
    /** The classes and named functions it sits in, outermost first, joined with `.`, or `<module>`. */
    fn: string;
    /** What it calls, as written, or what makes it a delete. */
    call: string;
    line: number;
}

const DELETE_NAMES = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rimraf', 'rimrafSync', 'unlinkat', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync', 'mkdtempDisposable', 'mkdtempDisposableSync']);
/** Packages whose job is deleting files, and any subpath of one. Any import, re-export or require of one is a delete. */
const DELETE_MODULE_RE = /^(?:rimraf|del|fs-extra|trash)(?:\/|$)/;
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const PROCESS_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** node:vm's ways to run a string as code. */
const VM_NAMES = new Set(['runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction']);
/** The global object's names. A member chain ending in one, such as `globalThis.globalThis`, is the global object too. */
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
/** Where a shell word can start: the start, a separator, or right after an opening quote or backtick. */
const WORD = '(?:^|[\\s;&|(`"\'!])';
/** `rm`, `rmdir`, `unlink` or `shred` as a shell command, for a `.sh` file: bare, by path, escaped with `\`, quoted, or right after a quote. */
const SHELL_DELETE = new RegExp(`${WORD}\\\\?(["']?)(?:(?:/[\\w.+-]+)+/)?(rm|rmdir|unlink|shred)\\1(?=$|[\\s;&|)"'\`])`);
/** `find ... -delete`. */
const FIND_DELETE = /(?:^|\s)-delete\b/;

/** A function's name, where it has one: its own, or the variable, property or method it's assigned to, and a class's. */
function nameOf(node: ts.Node): string | null {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) return node.name.text;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return node.name.getText();
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
        if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText();
    }
    return null;
}

/** The classes and named functions around `node`, outermost first, as `runGc.held` or `Janitor.sweep`. Anonymous ones are passed over. */
export function enclosingFunction(node: ts.Node): string {
    const names: string[] = [];
    for (let current = node.parent; current; current = current.parent) {
        const name = nameOf(current);
        if (name) names.unshift(name);
    }
    return names.length > 0 ? names.join('.') : '<module>';
}

/** The name a call reaches: `rm` for `rm(x)`, `fs.promises.rm(x)` and `fs['rm'](x)`. */
export function calleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
    return null;
}

/** A string's text, or a template's literal parts joined by spaces. */
function stringText(node: ts.Node): string | null {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    return null;
}

const isLiteral = (node: ts.Node | undefined): node is ts.StringLiteralLike => node !== undefined && ts.isStringLiteralLike(node);

/** `node` without what wraps it: parentheses, `await`, `as`, `satisfies`, `<T>` and `!`. */
function bare(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    return current;
}

export function parse(file: string, text: string): ts.SourceFile {
    const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : /\.(?:ts|mts|cts)(?:\.txt)?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** What a file binds to child_process, to fs, and to a `require`. */
interface Bindings {
    /** Local names of child_process functions, to the function each is. */
    processNames: Map<string, string>;
    processObjects: Set<string>;
    fsObjects: Set<string>;
    requireNames: Set<string>;
    /** node:vm's module objects, and the classes bound from it by name. */
    vmObjects: Set<string>;
    vmClasses: Set<string>;
    /** worker_threads' module objects, and its Worker however it's bound (item 41). */
    workerObjects: Set<string>;
    workerClasses: Set<string>;
    /** Variables given the global object, by declaration or assignment. */
    globalAliases: Set<string>;
}

const VM_MODULES = new Set(['vm', 'node:vm']);
/**
 * Modules that run code or reach native bindings the rail can't follow:
 * node:vm, node:module (createRequire, _load), cluster, inspector, repl, wasi
 * and worker_threads, with or without `node:`, and any subpath. Nothing
 * shipped loads them, so any load is a finding (item 48).
 */
const CODE_MODULE_RE = /^(?:node:)?(?:vm|module|cluster|inspector|repl|wasi|worker_threads)(?:\/|$)/;
/** Members that load modules or native code, or replace the process, on any object (item 48). */
const LOADER_MEMBERS = new Set(['binding', '_linkedBinding', 'dlopen', 'execve', 'getBuiltinModule', 'createRequire', '_load', 'Function']);
const WORKER_MODULES = new Set(['worker_threads', 'node:worker_threads']);
const VM_CLASSES = new Set(['Script', 'SourceTextModule', 'SyntheticModule']);

/** A member's name, by `.name` or a literal key: `getBuiltinModule` for `process.getBuiltinModule` and `process['getBuiltinModule']`. */
function memberName(node: ts.Expression): { owner: ts.Expression; name: string } | null {
    if (ts.isPropertyAccessExpression(node)) return { owner: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node) && isLiteral(node.argumentExpression)) return { owner: node.expression, name: node.argumentExpression.text };
    return null;
}

const PROCESS_OWNER = /^(?:(?:globalThis|global|window|self)\.)?process$/;
const MODULE_OWNER = /^(?:module|(?:(?:globalThis|global)\.)?process\.mainModule|require\.main)$/;

/**
 * A call that loads a module: `require(x)`, `import(x)`, a `require` alias,
 * `createRequire(…)(x)`, `process.getBuiltinModule(x)` however `process` is
 * reached, and `module.require(x)` or `process.mainModule.require(x)`. Null
 * for any other call.
 */
function loader(node: ts.Node, known: Bindings): { kind: 'require' | 'import()'; specifier: ts.Expression | undefined } | null {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return { kind: 'import()', specifier: node.arguments[0] };
    if (ts.isIdentifier(callee) && (callee.text === 'require' || known.requireNames.has(callee.text))) return { kind: 'require', specifier: node.arguments[0] };
    if (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire') return { kind: 'require', specifier: node.arguments[0] };
    const member = memberName(callee);
    if (member) {
        const owner = bare(member.owner).getText().replace(/\?\./g, '.');
        if ((member.name === 'getBuiltinModule' && PROCESS_OWNER.test(owner)) || (member.name === 'require' && MODULE_OWNER.test(owner))) return { kind: 'require', specifier: node.arguments[0] };
    }
    return null;
}

/** The module a loading call names as a literal, or null. */
function loadedModule(node: ts.Node, known: Bindings): string | null {
    const loaded = loader(ts.isExpression(node) ? bare(node) : node, known);
    return loaded && isLiteral(loaded.specifier) ? loaded.specifier.text : null;
}

/** Whether `node` is fs, `fs.promises`, `.default` of one, an alias, or a load of fs. */
function isFsObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.fsObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && (expression.name.text === 'promises' || expression.name.text === 'default')) return isFsObject(expression.expression, known);
    return FS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is child_process, `.default` of it, an alias, or a load of it. */
function isProcessObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'default') return isProcessObject(expression.expression, known);
    return PROCESS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is node:vm, `.default` of it, an alias, or a load of it. */
function isVmObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.vmObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'default') return isVmObject(expression.expression, known);
    return VM_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is worker_threads, `.default` of it, an alias, or a load of it. */
function isWorkerObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.workerObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'default') return isWorkerObject(expression.expression, known);
    return WORKER_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is a Worker: bound from worker_threads by any name, `.Worker` of anything, or named Worker. */
function isWorkerClass(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return expression.text === 'Worker' || known.workerClasses.has(expression.text);
    const member = memberName(expression);
    return member !== null && member.name === 'Worker';
}

/** Whether `node` is a variable given the global object, not one of its own names. */
function isGlobalAlias(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    return ts.isIdentifier(expression) && known.globalAliases.has(expression.text) && !GLOBALS.has(expression.text);
}

/** `process`, or `globalThis.process` and its kin, as a value: not a name being declared or a property's name. */
function isProcessGlobal(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return node.text === 'process' && !isDeclarationName(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
    return ts.isPropertyAccessExpression(node) && node.name.text === 'process' && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text);
}

/** Whether `process` at `node` is only read by a member, `process.env` or `process['env']`, or by `typeof`. */
function processMemberUse(node: ts.Expression): boolean {
    let current: ts.Node = node;
    while (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) current = current.parent;
    const parent = current.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) return true;
    return ts.isTypeOfExpression(parent);
}

/** Whether `node` is the global object: `globalThis`, `window`, `self` or `global`, a member chain ending in one, or a variable given one. */
function isGlobal(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return GLOBALS.has(expression.text) || known.globalAliases.has(expression.text);
    const member = memberName(expression);
    return member !== null && GLOBALS.has(member.name);
}

/** The child_process function `node` names, such as `exec` for `cp.exec`, `cp['exec']` or one bound from either, or null. */
function processFunction(node: ts.Expression, known: Bindings): string | null {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processNames.get(expression.text) ?? null;
    const member = memberName(expression);
    if (member && PROCESS_NAMES.has(member.name) && isProcessObject(member.owner, known)) return member.name;
    return null;
}

/** A property's key as text, quoted or not, or null for a computed key that isn't a literal. */
function keyText(name: ts.PropertyName | undefined): string | null {
    if (name === undefined) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return isLiteral(name.expression) ? name.expression.text : null;
    return null;
}

/** The key a binding element takes: `rm` for `{ rm }`, `{ rm: r }`, `{ 'rm': r }` and `{ ['rm']: r }`, or null for a computed key that isn't a literal. */
function bindingKey(element: ts.BindingElement, source: ts.SourceFile): string | null {
    if (element.propertyName === undefined) return element.name.getText(source);
    return keyText(element.propertyName);
}

/**
 * Every name a file binds to child_process, to fs, and to a `require`,
 * through imports (`default` included), `import x = require()`, loads,
 * destructuring (`{ default: x }` included), plain aliases and
 * `promisify()`, until nothing new turns up. An alias is followed here and is
 * also an escape the rail fails on.
 */
function bindings(source: ts.SourceFile): Bindings {
    const known: Bindings = { processNames: new Map(), processObjects: new Set(), fsObjects: new Set(), requireNames: new Set(), vmObjects: new Set(), vmClasses: new Set(), workerObjects: new Set(), workerClasses: new Set(), globalAliases: new Set() };
    const size = () => known.processNames.size + known.processObjects.size + known.fsObjects.size + known.requireNames.size + known.vmObjects.size + known.vmClasses.size + known.workerObjects.size + known.workerClasses.size + known.globalAliases.size;
    const bindObject = (objects: Set<string>, named: { local: string; imported: string }[], isProcess: boolean) => {
        for (const { local, imported } of named) {
            if (imported === 'default') objects.add(local);
            if (isProcess && PROCESS_NAMES.has(imported)) known.processNames.set(local, imported);
            if (!isProcess && imported === 'promises') known.fsObjects.add(local);
        }
    };
    const bindModule = (module: string, name: ts.BindingName | undefined, named: { local: string; imported: string }[], namespace?: string) => {
        if (VM_MODULES.has(module)) {
            if (name && ts.isIdentifier(name)) known.vmObjects.add(name.text);
            if (namespace) known.vmObjects.add(namespace);
            for (const { local, imported } of named) if (VM_CLASSES.has(imported)) known.vmClasses.add(local);
            return;
        }
        if (WORKER_MODULES.has(module)) {
            if (name && ts.isIdentifier(name)) known.workerObjects.add(name.text);
            if (namespace) known.workerObjects.add(namespace);
            for (const { local, imported } of named) {
                if (imported === 'Worker') known.workerClasses.add(local);
                if (imported === 'default') known.workerObjects.add(local);
            }
            return;
        }
        const isProcess = PROCESS_MODULES.has(module);
        const objects = isProcess ? known.processObjects : FS_MODULES.has(module) ? known.fsObjects : null;
        if (objects === null) return;
        if (name && ts.isIdentifier(name)) objects.add(name.text);
        if (namespace) objects.add(namespace);
        bindObject(objects, named, isProcess);
    };
    const destructured = (pattern: ts.BindingName) => (ts.isObjectBindingPattern(pattern) ? pattern.elements.map((each) => ({ local: each.name.getText(source), imported: bindingKey(each, source) ?? '' })) : []);
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && isLiteral(node.moduleSpecifier) && node.importClause) {
            const { name, namedBindings } = node.importClause;
            bindModule(
                node.moduleSpecifier.text,
                name,
                namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements.map((each) => ({ local: each.name.text, imported: (each.propertyName ?? each.name).text })) : [],
                namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings.name.text : undefined,
            );
        }
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLiteral(node.moduleReference.expression)) {
            bindModule(node.moduleReference.expression.text, node.name, []);
        }
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const init = bare(node.initializer);
            const module = loadedModule(init, known);
            if (module !== null) bindModule(module, node.name, destructured(node.name));
            if (ts.isIdentifier(node.name)) {
                if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'createRequire') known.requireNames.add(node.name.text);
                if (ts.isIdentifier(init) && (init.text === 'require' || known.requireNames.has(init.text))) known.requireNames.add(node.name.text);
                const promisified = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'promisify' && init.arguments[0] ? processFunction(init.arguments[0], known) : null;
                if (promisified) known.processNames.set(node.name.text, promisified);
                const fn = processFunction(init, known);
                if (fn) known.processNames.set(node.name.text, fn);
            }
            if (isProcessObject(init, known)) {
                if (ts.isIdentifier(node.name)) known.processObjects.add(node.name.text);
                bindObject(known.processObjects, destructured(node.name), true);
            }
            if (isFsObject(init, known)) {
                if (ts.isIdentifier(node.name)) known.fsObjects.add(node.name.text);
                bindObject(known.fsObjects, destructured(node.name), false);
            }
            // node:vm and worker_threads by alias, destructuring or `.Name`, as `const W = workers.Worker`.
            if (module === null && isVmObject(init, known)) bindModule('node:vm', node.name, destructured(node.name));
            if (module === null && isWorkerObject(init, known)) bindModule('node:worker_threads', node.name, destructured(node.name));
            const member = memberName(init);
            if (ts.isIdentifier(node.name) && member && VM_CLASSES.has(member.name) && isVmObject(member.owner, known)) known.vmClasses.add(node.name.text);
            if (ts.isIdentifier(node.name) && member && member.name === 'Worker' && isWorkerObject(member.owner, known)) known.workerClasses.add(node.name.text);
            if (ts.isIdentifier(node.name) && isGlobal(init, known)) known.globalAliases.add(node.name.text);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isGlobal(node.right, known)) known.globalAliases.add(node.left.text);
        ts.forEachChild(node, visit);
    };
    for (let before = -1; before !== size();) {
        before = size();
        visit(source);
    }
    return known;
}

/** Whether `node` sits in a type, such as `typeof fs.statSync`, where nothing runs. */
function inType(node: ts.Node): boolean {
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
        if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
        if (ts.isStatement(current)) return false;
    }
    return false;
}

/**
 * Whether a module object, `fs.promises` or `.default` at `node` is used only
 * as the escape rule allows (item 27's S6 and S7): `.name` access, element
 * access (a computed key is its own finding), destructuring (a computed key
 * is its own finding), the first argument of `Reflect.get` (its own
 * finding), or, for a load, a binding of it. An `import()` must be awaited
 * first.
 */
function allowedUse(node: ts.Expression, isLoad: boolean, mustAwait: boolean): boolean {
    let current: ts.Node = node;
    let awaited = false;
    while (ts.isParenthesizedExpression(current.parent) || ts.isAwaitExpression(current.parent) || ts.isNonNullExpression(current.parent)) {
        if (ts.isAwaitExpression(current.parent)) awaited = true;
        current = current.parent;
    }
    if (mustAwait && !awaited) return false;
    const parent = current.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) return true;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) return ts.isObjectBindingPattern(parent.name) || isLoad;
    if (ts.isCallExpression(parent) && parent.arguments[0] === current && ts.isPropertyAccessExpression(parent.expression) && parent.expression.getText() === 'Reflect.get') return true;
    return false;
}

/** Whether an identifier is a name being declared or a property's name, not a use. */
function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if (ts.isQualifiedName(parent)) return true;
    if (ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent) || ts.isImportEqualsDeclaration(parent)) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isBindingElement(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    return false;
}

/** A call as the rail names it: its whole text, whitespace normalised. */
const callText = (node: ts.CallExpression, source: ts.SourceFile) => node.getText(source).replace(/\s+/g, ' ').trim();

/** How a process call's finding starts: the whole call follows, its whitespace normalised (item 43). */
export const PROCESS_CALL = 'runs a process: ';

/** Every delete call in one source text. `file` is how findings name it. */
export function scanSource(file: string, text: string): DeleteCall[] {
    const source = parse(file, text);
    const known = bindings(source);
    const found: DeleteCall[] = [];
    const add = (node: ts.Node, call: string) => {
        found.push({ file, fn: enclosingFunction(node), call, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    };
    /** Strings a process call's arguments hold are judged there, once. */
    const inProcessArgs = new Set<ts.Node>();
    const isCallee = (node: ts.Node) => (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node;
    /** Classes this file declares itself: `new Script()` is node:vm's unless one of them is named Script. */
    const ownClasses = new Set<string>();
    const collect = (node: ts.Node) => {
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) ownClasses.add(node.name.text);
        ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node) => {
        let module: string | null = null;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) module = node.moduleSpecifier.text;
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLiteral(node.moduleReference.expression)) module = node.moduleReference.expression.text;
        // The load itself, once: not again for the parentheses or the await around it.
        else if (ts.isCallExpression(node)) module = loadedModule(node, known);
        const typeOnly = (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) || (ts.isExportDeclaration(node) && node.isTypeOnly);
        if (module !== null && DELETE_MODULE_RE.test(module)) add(node, `module ${module}`);
        // node:vm, node:module, cluster, inspector, repl, wasi and worker_threads run code the rail can't read, so any load is a finding (items 39 and 48).
        if (module !== null && CODE_MODULE_RE.test(module) && !typeOnly) add(node, `module ${module}, which the rail can't read`);
        // A re-export hands fs or child_process to modules the rail doesn't follow.
        if (ts.isExportDeclaration(node) && module !== null && (FS_MODULES.has(module) || PROCESS_MODULES.has(module))) add(node, `re-exports ${module}`);
        const loading = loader(node, known);
        if (loading && !isLiteral(loading.specifier)) add(node, `${loading.kind} of a module that isn't a literal`);
        if (loading && isLiteral(loading.specifier) && /^data:/i.test(loading.specifier.text)) add(node, `${loading.kind} of a data: URL, which the rail can't read`);
        // The escape rule, for a load of fs or child_process.
        if (loading && module !== null && (FS_MODULES.has(module) || PROCESS_MODULES.has(module)) && !allowedUse(node as ts.Expression, true, loading.kind === 'import()')) add(node, `escapes ${node.getText(source)}`);
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            // A delete call is named by the whole call too, its target and options included, so changing what it deletes fails the rail (item 52).
            if (name !== null && DELETE_NAMES.has(name)) add(node, callText(node, source));
            if (name !== null && VM_NAMES.has(name)) add(node, `${node.expression.getText(source)}, which the rail can't read`);
            // Every process call, whatever it runs: the rail reads no command line (item 39), and pins the whole call, arguments and options included (item 43).
            if (processFunction(node.expression, known)) {
                add(node, `${PROCESS_CALL}${callText(node, source)}`);
                node.arguments.forEach((argument) => inProcessArgs.add(argument));
            }
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === 'Reflect.get' && node.arguments[0] && (isFsObject(node.arguments[0], known) || isProcessObject(node.arguments[0], known))) {
                add(node, `${callee.getText(source)}(${node.arguments[0].getText(source)}, …)`);
            }
            // Reflect.get on the global object reaches eval and everything else on it.
            const first = node.arguments[0] ? bare(node.arguments[0]) : undefined;
            if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === 'Reflect.get' && first && isGlobal(first, known)) {
                add(node, `${callee.getText(source)}(${first.getText(source)}, …), which the rail can't read`);
            }
            if (ts.isIdentifier(callee) && callee.text === 'Function') add(node, "Function, which the rail can't read");
            // Any .constructor(…) call, which reaches Function from any function (item 48).
            const called = memberName(callee);
            if (called && called.name === 'constructor') add(node, `${callee.getText(source)}(…), which the rail can't read`);
        } else if (ts.isNewExpression(node)) {
            const created = bare(node.expression);
            const named = ts.isIdentifier(created) ? created.text : ts.isPropertyAccessExpression(created) ? created.name.text : null;
            if (named === 'Function') add(node, `new ${node.expression.getText(source)}, which the rail can't read`);
            // node:vm's Script and modules, however bound; a bare Script is node:vm's unless this file declares a class of that name (item 41).
            const fromVm = (ts.isIdentifier(created) && (known.vmClasses.has(created.text) || (VM_CLASSES.has(created.text) && !ownClasses.has(created.text)))) || (ts.isPropertyAccessExpression(created) && VM_CLASSES.has(created.name.text) && isVmObject(created.expression, known));
            if (fromVm) add(node, `new ${node.expression.getText(source)}, which the rail can't read`);
            // Any Worker, however it's bound, whatever it's given (item 48); and anything else made with eval in its options.
            const options = node.arguments?.[1];
            if (isWorkerClass(node.expression, known)) add(node, `new ${node.expression.getText(source)}, a Worker, which the rail can't read`);
            else if (options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some((each) => !ts.isSpreadAssignment(each) && keyText(each.name) === 'eval' && !(ts.isPropertyAssignment(each) && each.initializer.kind === ts.SyntaxKind.FalseKeyword))) {
                add(node, `new ${node.expression.getText(source)} with eval, which the rail can't read`);
            }
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            if (!isCallee(node)) add(node, node.getText(source));
        } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'eval' && isGlobal(node.expression, known)) {
            add(node, `${node.getText(source)}, which the rail can't read`);
        } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && LOADER_MEMBERS.has(memberName(node)?.name ?? '') && !inType(node)) {
            // process.binding, process.dlopen, Module._load, createRequire, x.Function and their kin, on any object (item 48).
            add(node, `${node.getText(source)}, which the rail can't read`);
        } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isGlobalAlias(node.expression, known) && !inType(node)) {
            // On a variable given the global object, every member fails closed: only globalSlot()'s read is allowlisted (item 48).
            add(node, `${node.getText(source)}, which the rail can't read`);
        } else if (ts.isElementAccessExpression(node) && isGlobal(node.expression, known) && (!isLiteral(node.argumentExpression) || node.argumentExpression.text === 'eval')) {
            // A computed key on the global object can reach eval or anything else, so it fails closed; only the allowlist gets one past.
            add(node, `${node.getText(source)}, which the rail can't read`);
        } else if (ts.isElementAccessExpression(node)) {
            const key = node.argumentExpression;
            if (isLiteral(key) && DELETE_NAMES.has(key.text) && !isCallee(node)) add(node, node.getText(source));
            else if (!isLiteral(key) && (isFsObject(node.expression, known) || isProcessObject(node.expression, known))) add(node, `computed access ${node.getText(source)}`);
        } else if (ts.isImportSpecifier(node) && DELETE_NAMES.has((node.propertyName ?? node.name).getText(source))) {
            add(node, `import ${node.getText(source)}`);
        } else if (ts.isBindingElement(node)) {
            const key = bindingKey(node, source);
            const from = ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.initializer : undefined;
            if (key !== null && DELETE_NAMES.has(key)) add(node, `destructure ${node.getText(source)}`);
            else if (key === null && from && (isFsObject(from, known) || isProcessObject(from, known) || isGlobal(from, known))) add(node, `computed destructure ${node.getText(source)}`);
            else if (key === 'eval' && from && isGlobal(from, known)) add(node, `destructure ${node.getText(source)}, which the rail can't read`);
        } else if (ts.isIdentifier(node) && node.text === 'eval' && !isDeclarationName(node) && !inType(node)) {
            // eval in any form, direct or indirect, such as (0, eval)(…).
            add(node, "eval, which the rail can't read");
        } else if (!inProcessArgs.has(node)) {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
        // A variable given the global object: its computed keys are followed, and it fails closed itself (item 41).
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isGlobal(node.initializer, known)) add(node, `${node.name.text} = ${bare(node.initializer).getText(source)}, which the rail can't read`);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isGlobal(node.right, known)) add(node, `${node.left.getText(source)} = ${bare(node.right).getText(source)}, which the rail can't read`);
        // process itself, aliased, destructured, passed or assigned, fails closed: only `process.name` and `typeof process` are read (item 48).
        if (isProcessGlobal(node) && !inType(node) && !processMemberUse(node as ts.Expression)) add(node, `escapes ${node.getText(source)}`);
        // The escape rule, for fs, child_process, fs.promises and .default by name.
        const named = ts.isIdentifier(node) && (known.fsObjects.has(node.text) || known.processObjects.has(node.text)) && !isDeclarationName(node);
        const member = ts.isPropertyAccessExpression(node) && ((node.name.text === 'promises' && isFsObject(node.expression, known)) || (node.name.text === 'default' && (isFsObject(node.expression, known) || isProcessObject(node.expression, known))));
        if ((named || member) && !inType(node) && !allowedUse(node as ts.Expression, false, false)) add(node, `escapes ${node.getText(source)}`);
        // A child_process function handed on to anything but promisify(), which the bindings follow, can't be read.
        if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && !isCallee(node) && processFunction(node as ts.Expression, known) !== null) {
            const parent = node.parent;
            const declared = ts.isIdentifier(node) && isDeclarationName(node);
            const promisified = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'promisify';
            const bound = ts.isVariableDeclaration(parent) && parent.initializer === node;
            const reflected = ts.isCallExpression(parent) && parent.expression.getText(source) === 'Reflect.get';
            if (!declared && !promisified && !bound && !reflected && !(ts.isPropertyAccessExpression(parent) && parent.name === node)) add(node, `passes on ${node.getText(source)}`);
        }
        if (inProcessArgs.has(node)) ts.forEachChild(node, (child) => void inProcessArgs.add(child));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** Every delete call in a shell script, line by line. */
function scanShell(file: string, text: string): DeleteCall[] {
    return text.split('\n').flatMap((line, index) => (!/^\s*#/.test(line) && (SHELL_DELETE.test(line.trim()) || FIND_DELETE.test(line)) ? [{ file, fn: '<shell>', call: line.trim(), line: index + 1 }] : []));
}

/** A pattern that matches exactly these paths and nothing else, so a new file beside them is scanned. */
const exactly = (files: readonly string[]) => new RegExp(`^(?:${files.map((file) => file.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('|')})$`);

/**
 * What the rail leaves out of "every source file in the repository", each
 * with its reason (item 44). Everything else with a source extension is
 * scanned: app/, components/, lib/, utils/, scripts/, data/, the root files
 * such as proxy.ts, instrumentation.ts and next.config.mjs, the tool
 * configs, and every file in test/, e2e/ and ci/ but the ones named here,
 * each of which holds a delete, a process call or a form the rail can't
 * read. A test pins that every one named does, so none stays here after it
 * no longer needs to.
 */
export const RAIL_EXCLUSIONS: readonly { pattern: RegExp; reason: string }[] = [
    { pattern: /(?:^|\/)__tests__\//, reason: 'tests: vitest runs them; nothing ships them' },
    { pattern: /\.(?:test|spec)\.[cm]?[jt]sx?$/, reason: 'tests: vitest runs them; nothing ships them' },
    {
        pattern: exactly(['e2e/budgets/run.ts', 'e2e/support/carry-over.ts', 'e2e/support/catalogServer.ts', 'e2e/support/curation-inbox.ts', 'e2e/support/inbox-gate.ts', 'e2e/support/touch.ts', 'e2e/support/write-site-config.ts', 'e2e/themes/build.ts']),
        reason: "Playwright's runners and support files, run against a built site in CI and never shipped, that remove the fixtures and copies they made, start the build or server under test, remove page nodes, or keep state on the page's window",
    },
    { pattern: /^playwright\.config\.ts$/, reason: "Playwright's config for the e2e/ run, which removes the temp folders it made for that run when it exits; nothing ships it" },
    {
        pattern: exactly(['ci/audit-gate.mjs', 'ci/check-compose.sh', 'ci/perf/ab.mjs', 'ci/release-plan.mjs', 'ci/smoke-catalog.sh', 'ci/smoke-image.sh', 'ci/smoke-ingest.sh', 'ci/smoke-media.sh', 'ci/smoke-watcher-once.sh', 'ci/themes-budget.mjs']),
        reason: "CI's own scripts, which run in CI only and aren't shipped, that remove the temp folders and containers they made, run git, npm or the server they measure, or load a built bundle's code",
    },
    { pattern: exactly(['test/fixtures/deleteRail/stray.ts', 'test/fixtures/deleteRail/strayForms.ts']), reason: "the rail's own positive controls, which hold every form it catches on purpose and are only ever parsed" },
    {
        pattern: exactly([
            'test/helpers/caseDisk.ts',
            'test/helpers/curatorSecrets.ts',
            'test/helpers/deleteCalls.ts',
            'test/helpers/directorySyncs.ts',
            'test/helpers/noHardLinks.preload.mjs',
            'test/helpers/noHardLinks.ts',
            'test/helpers/parityWalk.ts',
            'test/helpers/publishFixture.ts',
            'test/helpers/runTsx.ts',
            'test/helpers/standaloneServer.ts',
            'test/helpers/tempDataRoot.ts',
            'test/helpers/tempLibrary.ts',
            'test/helpers/watcherProcess.ts',
            'test/matchMedia.ts',
        ]),
        reason: "the test suite's helpers and stubs, never shipped, that remove the temp folders they made, start the script or server under test, stand in for fs, remove page nodes or listeners, or are the rail's own scanner",
    },
    { pattern: /(?:^|\/)node_modules\//, reason: "dependencies, not this repository's code" },
    { pattern: /^\.next\//, reason: "Next's build output, made from the scanned sources" },
];

const RAIL_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/;

/** Every source file in the repository, tracked or new and not ignored, relative to its root and sorted, before the exclusions. */
export function repositorySources(root: string = REPO_ROOT): string[] {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(listed.split('\0').filter((file) => RAIL_EXTENSIONS.test(file) && fs.existsSync(path.join(root, file))))].sort();
}

/** The exclusion that leaves `file` out of the rail, or null when it's scanned. */
export const exclusionOf = (file: string) => RAIL_EXCLUSIONS.find((each) => each.pattern.test(file)) ?? null;

/** Every source file the rail scans: every one in the repository but what RAIL_EXCLUSIONS leaves out. */
export function shippedFiles(root: string = REPO_ROOT): string[] {
    return repositorySources(root).filter((file) => exclusionOf(file) === null);
}

/** Every delete call in `text`, read as the file `file`: a shell script line by line, any other source parsed. */
export const scanText = (file: string, text: string): DeleteCall[] => (file.endsWith('.sh') ? scanShell(file, text) : scanSource(file, text));

/** Every delete call in `files`. */
export function deleteCalls(files: readonly string[]): DeleteCall[] {
    return files.flatMap((file) => scanText(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
}

/**
 * Every identifier named `name` in each of `files`, calls, references and its
 * declaration alike, as `<file> <functions>`. A declaration's own name counts
 * where the declaration sits.
 */
export function identifierSites(files: readonly string[], name: string): string[] {
    return files.filter((file) => !file.endsWith('.sh')).flatMap((file) => {
        const source = parse(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        const found: string[] = [];
        const visit = (node: ts.Node) => {
            if (ts.isIdentifier(node) && node.text === name) {
                const declared = (node.parent as { name?: ts.Node }).name === node;
                found.push(`${file} ${enclosingFunction(declared ? node.parent : node)}`);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return found;
    });
}

/** Every call to a function named `name` in each of `files`, as `<file> <functions>`. */
export function callersAcross(files: readonly string[], name: string): string[] {
    return files.filter((file) => !file.endsWith('.sh')).flatMap((file) => callSites(file, name).map((site) => `${file} ${site.fn}`));
}

/** Every call to a function named `name` in `file`, with the functions it sits in. */
export function callSites(file: string, name: string): { fn: string; node: ts.CallExpression }[] {
    const source = parse(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const found: { fn: string; node: ts.CallExpression }[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && calleeName(node.expression) === name) found.push({ fn: enclosingFunction(node), node });
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}
