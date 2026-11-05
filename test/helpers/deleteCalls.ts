/**
 * The delete-call rail (#181's A10 review): every call in the source tree
 * that can delete a file or a folder, with the file and the named function
 * it sits in, so a test can hold them to an allowlist. It reads the source
 * with the TypeScript parser and runs nothing. It fails closed: a form it
 * can't resolve is a finding too, and only the allowlist gets one past.
 *
 * It finds:
 *   - `rm`, `rmSync`, `rmdir`, `unlink`, `rimraf`, `remove`, `emptyDir`,
 *     `mkdtempDisposable` and their kin however they're reached: called,
 *     passed on, imported, destructured, or by a literal key;
 *   - any import, re-export, `require()`, `import()`,
 *     `process.getBuiltinModule()`, `module.require()` or `createRequire()`
 *     load of `rimraf`, `del`, `fs-extra` or `trash`, or a subpath of one;
 *   - a child_process call, however child_process is reached, that runs
 *     `rm`, `rmdir`, `unlink`, `shred`, `rimraf`, `git clean`, `git rm`,
 *     `git worktree remove` or `find -delete`, after `env`, `sudo`, `xargs`,
 *     `nice`, `timeout` and `npx`, in any argument, or a `node -e` script
 *     that does;
 *   - and, failing closed: a command, argument list or shell script that
 *     isn't a literal; a shell or interpreter with no literal script, which
 *     may read one on stdin; any other interpreter's script; options it
 *     can't read beside arguments that aren't literals; `eval`,
 *     `new Function` and a `Worker` with `eval`; `require()` or `import()`
 *     of a name that isn't a literal; computed access or destructuring on
 *     fs or child_process; and any other use of an fs or child_process
 *     module object, or `fs.promises`, than `.name` access or destructuring
 *     with literal keys, such as passing, assigning, spreading or exporting
 *     it, or `.then()` on its `import()`.
 *
 * It scans the shipped directories only. Overwriting renames and copies onto
 * existing paths, and `ci/*.sh`, are out of its scope.
 */

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
/** child_process functions that take one shell command string. */
const SHELL_STRING = new Set(['exec', 'execSync']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Interpreters by family, matched by pattern (`python3.12`, `node22`), and the flags that take a script to run. */
const INTERPRETER_RE = /^(node|nodejs|perl|python|ruby|bun|deno)(?:\d+(?:\.\d+)*)?$/;
const SCRIPT_FLAGS: Record<string, readonly string[]> = { node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], python: ['-c'], ruby: ['-e'], bun: ['-e', '--eval'], deno: ['eval'] };
/** Commands that run another, and their options that take a value. */
const WRAPPERS: Record<string, readonly string[]> = {
    env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
    sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'],
    xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--replace', '--arg-file', '--delimiter'],
    nice: ['-n', '--adjustment'],
    timeout: ['-k', '-s', '--kill-after', '--signal'],
    npx: ['-p', '--package', '-c', '--call'],
};
/** Commands that delete what they're given. */
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'rimraf', 'del-cli', 'trash']);
/** Where a shell word can start: the start, a separator, or right after an opening quote or backtick. */
const WORD = '(?:^|[\\s;&|(`"\'])';
/** `rm`, `rmdir`, `unlink` or `shred` as a shell command: bare, by path, escaped with `\`, quoted, or right after a quote. */
const SHELL_DELETE = new RegExp(`${WORD}\\\\?(["']?)(?:/(?:usr/)?bin/)?(rm|rmdir|unlink|shred)\\1(?=$|[\\s;&|)"'\`])`);
/** `git`, with any options, then `clean`, `rm` or `worktree remove`. */
const GIT_DELETE = new RegExp(`${WORD}git\\b[^;&|\\n]*?\\s(clean|rm|worktree\\s+(?:remove|prune))\\b`);
/** `rimraf`, `del-cli` or `trash` as a command, through `npx` or not. */
const DELETE_TOOL = new RegExp(`${WORD}(rimraf|del-cli|trash)(?=$|[\\s;&|)"'\`])`);
/** `find ... -delete`. */
const FIND_DELETE = /(?:^|\s)-delete\b/;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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

/** Every string text anywhere in `nodes`: literals, templates, array elements, object values, nested. */
function allStrings(nodes: readonly ts.Node[]): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
        const text = stringText(node);
        if (text !== null) found.push(text);
        ts.forEachChild(node, visit);
    };
    nodes.forEach(visit);
    return found;
}

/** `node` without what wraps it: parentheses, `await`, `as` and `!`. */
function bare(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
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
}

/** A call that loads a module: `require(x)`, `import(x)`, `process.getBuiltinModule(x)`, `module.require(x)`, a `require` alias, or `createRequire(…)(x)`. Null for any other call. */
function loader(node: ts.Node, known: Bindings): { kind: 'require' | 'import()'; specifier: ts.Expression | undefined } | null {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return { kind: 'import()', specifier: node.arguments[0] };
    if (ts.isIdentifier(callee) && (callee.text === 'require' || known.requireNames.has(callee.text))) return { kind: 'require', specifier: node.arguments[0] };
    if (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire') return { kind: 'require', specifier: node.arguments[0] };
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const owner = callee.expression.text;
        if ((owner === 'process' && callee.name.text === 'getBuiltinModule') || (owner === 'module' && callee.name.text === 'require')) return { kind: 'require', specifier: node.arguments[0] };
    }
    return null;
}

/** The module a loading call names as a literal, or null. */
function loadedModule(node: ts.Node, known: Bindings): string | null {
    const loaded = loader(ts.isExpression(node) ? bare(node) : node, known);
    return loaded && isLiteral(loaded.specifier) ? loaded.specifier.text : null;
}

/** Whether `node` is fs, `fs.promises`, an alias of either, or a load of fs. */
function isFsObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.fsObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'promises') return isFsObject(expression.expression, known);
    return FS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is child_process, an alias of it, or a load of it. */
function isProcessObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processObjects.has(expression.text);
    return PROCESS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** The child_process function `node` names, such as `exec` for `cp.exec`, `cp['exec']` or one bound from either, or null. */
function processFunction(node: ts.Expression, known: Bindings): string | null {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processNames.get(expression.text) ?? null;
    if (ts.isPropertyAccessExpression(expression) && PROCESS_NAMES.has(expression.name.text) && isProcessObject(expression.expression, known)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && isLiteral(expression.argumentExpression) && PROCESS_NAMES.has(expression.argumentExpression.text) && isProcessObject(expression.expression, known)) return expression.argumentExpression.text;
    return null;
}

/** The key a binding element takes: `rm` for `{ rm }`, `{ rm: r }` and `{ ['rm']: r }`, or null for a computed key that isn't a literal. */
function bindingKey(element: ts.BindingElement, source: ts.SourceFile): string | null {
    const key = element.propertyName ?? element.name;
    if (ts.isComputedPropertyName(key)) return isLiteral(key.expression) ? key.expression.text : null;
    return key.getText(source);
}

/**
 * Every name a file binds to child_process, to fs, and to a `require`,
 * through imports, `import x = require()`, loads, destructuring, plain
 * aliases and `promisify()`, until nothing new turns up. An alias is followed
 * here and is also an escape the rail fails on.
 */
function bindings(source: ts.SourceFile): Bindings {
    const known: Bindings = { processNames: new Map(), processObjects: new Set(), fsObjects: new Set(), requireNames: new Set() };
    const size = () => known.processNames.size + known.processObjects.size + known.fsObjects.size + known.requireNames.size;
    const bindModule = (module: string, name: ts.BindingName | undefined, named: { local: string; imported: string }[], namespace?: string) => {
        const objects = PROCESS_MODULES.has(module) ? known.processObjects : FS_MODULES.has(module) ? known.fsObjects : null;
        if (objects === null) return;
        if (name && ts.isIdentifier(name)) objects.add(name.text);
        if (namespace) objects.add(namespace);
        for (const { local, imported } of named) {
            if (PROCESS_MODULES.has(module) && PROCESS_NAMES.has(imported)) known.processNames.set(local, imported);
            if (FS_MODULES.has(module) && imported === 'promises') known.fsObjects.add(local);
        }
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
                for (const { local, imported } of destructured(node.name)) if (PROCESS_NAMES.has(imported)) known.processNames.set(local, imported);
            }
            if (isFsObject(init, known)) {
                if (ts.isIdentifier(node.name)) known.fsObjects.add(node.name.text);
                for (const { local, imported } of destructured(node.name)) if (imported === 'promises') known.fsObjects.add(local);
            }
        }
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
 * Whether a module object, or `fs.promises`, at `node` is used only as the
 * escape rule allows (item 27's S6 and S7): `.name` access, element access
 * (a computed key is its own finding), destructuring (a computed key is its
 * own finding), the first argument of `Reflect.get` (its own finding), or,
 * for a load, a binding of it. An `import()` must be awaited first.
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
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    return false;
}

/** A process call's options: the argument after the list for spawn and its kin, after the command for exec, when there is one. Null when it has none, or a callback stands there. */
function optionsOf(node: ts.CallExpression, shellString: boolean): ts.Expression | null {
    const args = node.arguments;
    const at = shellString ? 1 : args[1] !== undefined && (ts.isArrayLiteralExpression(args[1]) || !ts.isObjectLiteralExpression(args[1])) ? 2 : 1;
    const options = args[at];
    if (options === undefined || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) return null;
    return options;
}

/** Whether options are what the rail can read as running no shell: an object literal with no spread, and `shell` absent or literally `false`. Null when they may run one: `true` when `shell` is literally `true`. */
function shellRead(options: ts.Expression | null): 'none' | 'true' | 'unreadable' {
    if (options === null) return 'none';
    if (!ts.isObjectLiteralExpression(options)) return 'unreadable';
    for (const property of options.properties) {
        if (ts.isSpreadAssignment(property)) return 'unreadable';
        if (property.name?.getText() !== 'shell') continue;
        if (!ts.isPropertyAssignment(property)) return 'unreadable';
        if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
        return property.initializer.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'unreadable';
    }
    return 'none';
}

/** Why a command line given as strings deletes: `rm` and its family, `git` deleting, a delete tool, or `find -delete`. */
function stringsReason(strings: readonly string[]): string | null {
    for (const text of strings) {
        const git = GIT_DELETE.exec(text);
        if (git) return `runs git ${git[1].replace(/\s+/g, ' ').replace('prune', 'remove')}`;
    }
    for (const text of strings) {
        const deleting = SHELL_DELETE.exec(text);
        if (deleting) return `runs ${deleting[2]}`;
    }
    for (const text of strings) {
        const tool = DELETE_TOOL.exec(text);
        if (tool) return `runs ${tool[1]}`;
    }
    return strings.some((text) => FIND_DELETE.test(text)) ? 'runs find -delete' : null;
}

/**
 * `command` and `elements` past `env`, `sudo`, `xargs`, `nice`, `timeout`
 * and `npx`, with their options. A stop when what they run isn't a literal.
 */
function unwrap(command: string, elements: readonly ts.Expression[]): { runs: string; rest: readonly ts.Expression[] } | { stop: string } | null {
    let runs = path.posix.basename(command.replace(/^\\/, ''));
    let rest = elements;
    while (runs in WRAPPERS) {
        const wrapper = runs;
        const valued = WRAPPERS[wrapper];
        let at = 0;
        let duration = wrapper !== 'timeout';
        for (; at < rest.length; at += 1) {
            const each = rest[at];
            if (!isLiteral(each)) return { stop: `runs ${wrapper} with a command that isn't a literal` };
            if (each.text.startsWith('-')) {
                if (valued.includes(each.text)) at += 1;
                continue;
            }
            if (wrapper === 'env' && each.text.includes('=')) continue;
            if (!duration) {
                duration = true;
                continue;
            }
            break;
        }
        const next = rest[at];
        if (next === undefined || !isLiteral(next)) return null;
        runs = path.posix.basename(next.text.replace(/^\\/, ''));
        rest = rest.slice(at + 1);
    }
    return { runs, rest };
}

/** What `git` with these arguments deletes, or a stop when its subcommand isn't a literal. */
function gitReason(rest: readonly ts.Expression[]): string | null {
    for (let at = 0; at < rest.length; at += 1) {
        const each = rest[at];
        if (!isLiteral(each)) return "runs git with arguments that aren't literals";
        if (each.text.startsWith('-')) {
            if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(each.text)) at += 1;
            continue;
        }
        if (each.text === 'clean' || each.text === 'rm') return `runs git ${each.text}`;
        const next = rest[at + 1];
        if (each.text === 'worktree' && next !== undefined && isLiteral(next) && (next.text === 'remove' || next.text === 'prune')) return 'runs git worktree remove';
        return null;
    }
    return null;
}

/**
 * Why a child_process call deletes, or might, or can't be read. Null when
 * it plainly doesn't. A form it can't resolve fails the rail closed (#181's
 * A10 review, items 24 and 27).
 */
function processReason(node: ts.CallExpression, fn: string): string | null {
    const shellString = SHELL_STRING.has(fn);
    const options = optionsOf(node, shellString);
    const args = node.arguments.filter((each) => each !== options && !ts.isArrowFunction(each) && !ts.isFunctionExpression(each));
    const [command, list] = args;
    const listLiteral = shellString || list === undefined || ts.isArrayLiteralExpression(list);
    const elements: readonly ts.Expression[] = !shellString && list && ts.isArrayLiteralExpression(list) ? list.elements : [];
    const nonLiteral = !isLiteral(command) || !listLiteral || elements.some((each) => !isLiteral(each));
    const unread = (): string | null => {
        const shell = shellRead(options);
        if (!nonLiteral || shell === 'none') return null;
        return shell === 'true' ? "with shell: true and arguments that aren't literals" : "with options the rail can't read, and arguments that aren't literals";
    };
    if (shellString || !isLiteral(command)) {
        const said = stringsReason(allStrings(args));
        if (said) return said;
        if (!isLiteral(command)) return "with a command that isn't a literal";
        return unread();
    }
    const first = path.posix.basename(command.text.replace(/^\\/, ''));
    if (!listLiteral && (first in WRAPPERS || first === 'git' || SHELLS.has(first) || INTERPRETER_RE.test(first))) return `runs ${first} with arguments that aren't a literal list`;
    const resolved = unwrap(command.text, elements);
    if (resolved === null) return unread();
    if ('stop' in resolved) return resolved.stop;
    const { runs, rest } = resolved;
    if (runs === 'git') {
        const git = gitReason(rest);
        if (git) return git;
    }
    if (DELETE_COMMANDS.has(runs)) return `runs ${runs}`;
    if (runs === 'find' && rest.some((each) => isLiteral(each) && each.text === '-delete')) return 'runs find -delete';
    const family = INTERPRETER_RE.exec(runs)?.[1];
    if (family) {
        const flag = rest.findIndex((each) => isLiteral(each) && SCRIPT_FLAGS[family].includes(each.text));
        const script = flag >= 0 ? rest[flag + 1] : undefined;
        if (flag < 0) return `runs ${runs} with no literal script, so it may read one from stdin or a file`;
        if (!isLiteral(script)) return `runs a ${runs} script that isn't a literal`;
        if (family === 'node' || family === 'nodejs') {
            // A node script is JavaScript: the rail reads it as it reads a file.
            const [inner] = scanSource(`${runs} -e`, script.text);
            if (inner) return `runs ${runs} -e with ${inner.call}`;
        } else {
            return `runs a ${runs} script, which the rail can't read`;
        }
    }
    if (SHELLS.has(runs)) {
        const flag = rest.findIndex((each) => isLiteral(each) && /^-\w*c\w*$/.test(each.text));
        if (flag < 0) return `runs ${runs} with no literal script, so it may read one from stdin or a file`;
        if (!isLiteral(rest[flag + 1])) return "runs a shell script that isn't a literal";
    }
    const said = stringsReason(allStrings(args));
    if (said) return said;
    if (SHELLS.has(runs) && rest.some((each) => !isLiteral(each))) return `runs ${runs} with arguments that aren't literals`;
    return unread();
}

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
    const visit = (node: ts.Node) => {
        let module: string | null = null;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) module = node.moduleSpecifier.text;
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLiteral(node.moduleReference.expression)) module = node.moduleReference.expression.text;
        else module = loadedModule(node, known);
        if (module !== null && DELETE_MODULE_RE.test(module)) add(node, `module ${module}`);
        const loading = loader(node, known);
        if (loading && !isLiteral(loading.specifier)) add(node, `${loading.kind} of a module that isn't a literal`);
        // The escape rule, for a load of fs or child_process.
        if (loading && module !== null && (FS_MODULES.has(module) || PROCESS_MODULES.has(module)) && !allowedUse(node as ts.Expression, true, loading.kind === 'import()')) add(node, `escapes ${node.getText(source)}`);
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name !== null && DELETE_NAMES.has(name)) add(node, node.expression.getText(source));
            const fn = processFunction(node.expression, known);
            if (fn) {
                const reason = processReason(node, fn);
                if (reason) add(node, `${node.expression.getText(source)} ${reason}`);
                node.arguments.forEach((argument) => inProcessArgs.add(argument));
            }
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === 'Reflect.get' && node.arguments[0] && isFsObject(node.arguments[0], known)) {
                add(node, `${callee.getText(source)}(${node.arguments[0].getText(source)}, …)`);
            }
            if (ts.isIdentifier(callee) && callee.text === 'eval') add(node, "eval, which the rail can't read");
            if (ts.isIdentifier(callee) && callee.text === 'Function') add(node, "Function, which the rail can't read");
        } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            if (node.expression.text === 'Function') add(node, "new Function, which the rail can't read");
            const workerOptions = node.arguments?.[1];
            if (node.expression.text === 'Worker' && workerOptions !== undefined) {
                const evaluated = !ts.isObjectLiteralExpression(workerOptions) || workerOptions.properties.some((each) => ts.isSpreadAssignment(each) || (each.name?.getText(source) === 'eval' && !(ts.isPropertyAssignment(each) && each.initializer.kind === ts.SyntaxKind.FalseKeyword)));
                if (evaluated) add(node, "new Worker with eval, which the rail can't read");
            }
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            if (!isCallee(node)) add(node, node.getText(source));
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
            else if (key === null && from && (isFsObject(from, known) || isProcessObject(from, known))) add(node, `computed destructure ${node.getText(source)}`);
        } else if (!inProcessArgs.has(node)) {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
        // The escape rule, for fs, child_process and fs.promises by name.
        const named = ts.isIdentifier(node) && (known.fsObjects.has(node.text) || known.processObjects.has(node.text)) && !isDeclarationName(node);
        const promises = ts.isPropertyAccessExpression(node) && node.name.text === 'promises' && isFsObject(node.expression, known);
        if ((named || promises) && !inType(node) && !allowedUse(node as ts.Expression, false, false)) add(node, `escapes ${node.getText(source)}`);
        // A child_process function handed on to anything but promisify(), which the bindings follow, can't be read.
        if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && !isCallee(node) && processFunction(node as ts.Expression, known) !== null) {
            const parent = node.parent;
            const declared = ts.isIdentifier(node) && isDeclarationName(node);
            const promisified = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'promisify';
            const bound = ts.isVariableDeclaration(parent) && parent.initializer === node;
            if (!declared && !promisified && !bound && !(ts.isPropertyAccessExpression(parent) && parent.name === node)) add(node, `passes on ${node.getText(source)}`);
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

/** Every source file under `dirs` and every one of `files`, tests and test fixtures left out, relative to the repository root. */
export function sourceFiles(dirs: readonly string[], files: readonly string[] = []): string[] {
    const found: string[] = [...files];
    for (const dir of dirs) {
        for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })) {
            const file = `${dir}/${entry.split(path.sep).join('/')}`;
            if (/(?:^|\/)(?:__tests__|node_modules)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
            if (SOURCE_EXTENSIONS.test(file) || file.endsWith('.sh')) found.push(file);
        }
    }
    return [...new Set(found)].sort();
}

/** Every delete call in `files`. */
export function deleteCalls(files: readonly string[]): DeleteCall[] {
    return files.flatMap((file) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        return file.endsWith('.sh') ? scanShell(file, text) : scanSource(file, text);
    });
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
