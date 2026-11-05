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
    env: ['-u', '-C', '--unset', '--chdir'],
    sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'],
    doas: ['-u', '-C'],
    xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--replace', '--arg-file', '--delimiter'],
    nice: ['-n', '--adjustment'],
    nohup: [],
    timeout: ['-k', '-s', '--kill-after', '--signal'],
    npx: ['-p', '--package'],
    busybox: [],
};
/** A wrapper's own flags that run a script or a shell the rail can't read: they fail it closed. */
const WRAPPER_SCRIPTS: Record<string, readonly string[]> = { npx: ['-c', '--call'], env: ['-S', '--split-string'], sudo: ['-s', '-i', '--shell', '--login'] };
/** node:vm's ways to run a string as code. */
const VM_NAMES = new Set(['runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction']);
/** Where `eval` hangs off the global object. */
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
/** Commands that delete what they're given. */
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'rimraf', 'del-cli', 'trash']);
/** Where a shell word can start: the start, a separator, or right after an opening quote or backtick. */
const WORD = '(?:^|[\\s;&|(`"\'!])';
/** `rm`, `rmdir`, `unlink` or `shred` as a shell command: bare, by path, escaped with `\`, quoted, or right after a quote. */
const SHELL_DELETE = new RegExp(`${WORD}\\\\?(["']?)(?:(?:/[\\w.+-]+)+/)?(rm|rmdir|unlink|shred)\\1(?=$|[\\s;&|)"'\`])`);
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
    /** node:vm's module objects, and the classes bound from it by name. */
    vmObjects: Set<string>;
    vmClasses: Set<string>;
}

const VM_MODULES = new Set(['vm', 'node:vm']);
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
    const known: Bindings = { processNames: new Map(), processObjects: new Set(), fsObjects: new Set(), requireNames: new Set(), vmObjects: new Set(), vmClasses: new Set() };
    const size = () => known.processNames.size + known.processObjects.size + known.fsObjects.size + known.requireNames.size + known.vmObjects.size + known.vmClasses.size;
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

/** A process call's options: the argument after the list for spawn and its kin, after the command for exec, when there is one. Null when it has none, or a callback stands there. */
function optionsOf(node: ts.CallExpression, shellString: boolean): ts.Expression | null {
    const args = node.arguments;
    const at = shellString ? 1 : args[1] !== undefined && (ts.isArrayLiteralExpression(args[1]) || !ts.isObjectLiteralExpression(args[1])) ? 2 : 1;
    const options = args[at];
    if (options === undefined || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) return null;
    return options;
}

/** Whether options run no shell as far as the rail can read: an object literal with no spread, and `shell`, quoted or not, absent or literally `false`. */
function shellRead(options: ts.Expression | null): 'none' | 'true' | 'unreadable' {
    if (options === null) return 'none';
    if (!ts.isObjectLiteralExpression(options)) return 'unreadable';
    for (const property of options.properties) {
        if (ts.isSpreadAssignment(property)) return 'unreadable';
        const key = keyText(property.name);
        if (key === null) return 'unreadable';
        if (key !== 'shell') continue;
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

/** A word of a command line: its text, or null when it isn't a literal. */
type Word = string | null;

const base = (command: string) => path.posix.basename(command.replace(/^\\/, ''));

/**
 * A shell command string as the commands in it, each split into words, with
 * quotes taken off: `a 'b c'; d` is `[['a', 'b c'], ['d']]`. Separators are
 * `;`, `&`, `|` and newlines outside quotes.
 */
function shellCommands(text: string): string[][] {
    const commands: string[][] = [];
    let words: string[] = [];
    let word: string | null = null;
    let quote: '"' | "'" | null = null;
    const end = () => {
        if (word !== null) words.push(word);
        word = null;
    };
    for (let at = 0; at < text.length; at += 1) {
        const char = text[at];
        if (quote) {
            if (char === quote) quote = null;
            else if (char === '\\' && quote === '"' && at + 1 < text.length) word = `${word ?? ''}${text[(at += 1)]}`;
            else word = `${word ?? ''}${char}`;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            word ??= '';
        } else if (char === '\\' && at + 1 < text.length) {
            word = `${word ?? ''}${text[(at += 1)]}`;
        } else if (/\s/.test(char) && char !== '\n') {
            end();
        } else if (char === ';' || char === '&' || char === '|' || char === '\n') {
            end();
            if (words.length > 0) commands.push(words);
            words = [];
        } else {
            word = `${word ?? ''}${char}`;
        }
    }
    end();
    if (words.length > 0) commands.push(words);
    return commands;
}

/**
 * `command` and `rest` past `env`, `sudo`, `doas`, `xargs`, `nice`, `nohup`,
 * `timeout`, `npx` and `busybox`, with their options. A stop when what they
 * run isn't a literal, or a wrapper's own script flag (`npx -c`, `env -S`,
 * `sudo -s` or `-i`) runs something the rail can't read. Null when they run
 * no command.
 */
function unwrap(command: string, words: readonly Word[]): { runs: string; rest: readonly Word[] } | { stop: string } | null {
    let runs = base(command);
    let rest = words;
    while (runs in WRAPPERS) {
        const wrapper = runs;
        const valued = WRAPPERS[wrapper];
        let at = 0;
        let duration = wrapper !== 'timeout';
        for (; at < rest.length; at += 1) {
            const each = rest[at];
            if (each === null) return { stop: `runs ${wrapper} with a command that isn't a literal` };
            if (each.startsWith('-')) {
                const scripts = WRAPPER_SCRIPTS[wrapper] ?? [];
                // `--split-string=…` by its name, and combined short flags such as `-si` by each letter.
                const flag = each.startsWith('--') ? each.split('=')[0] : each;
                if (scripts.includes(flag)) return { stop: `runs ${wrapper} ${flag}, which the rail can't read` };
                if (!each.startsWith('--') && each.length > 2 && [...each.slice(1)].some((letter) => scripts.includes(`-${letter}`))) return { stop: `runs ${wrapper} ${each}, which the rail can't read` };
                if (valued.includes(each)) at += 1;
                continue;
            }
            if (wrapper === 'env' && each.includes('=')) continue;
            if (!duration) {
                duration = true;
                continue;
            }
            break;
        }
        const next = rest[at];
        if (next === undefined || next === null) return null;
        runs = base(next);
        rest = rest.slice(at + 1);
    }
    return { runs, rest };
}

/** What `git` with these arguments deletes, or a stop when its subcommand isn't a literal. */
function gitReason(rest: readonly Word[]): string | null {
    for (let at = 0; at < rest.length; at += 1) {
        const each = rest[at];
        if (each === null) return "runs git with arguments that aren't literals";
        if (each.startsWith('-')) {
            if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(each)) at += 1;
            continue;
        }
        if (each === 'clean' || each === 'rm') return `runs git ${each}`;
        const next = rest[at + 1];
        if (each === 'worktree' && (next === 'remove' || next === 'prune')) return 'runs git worktree remove';
        return null;
    }
    return null;
}

/**
 * Why one command, as words, deletes, or might, or can't be read. `strings`
 * is every string the call holds, for what words alone don't show. Null when
 * it plainly doesn't.
 */
function wordsReason(command: string, words: readonly Word[], listLiteral: boolean, strings: readonly string[]): string | null {
    const first = base(command);
    if (!listLiteral && (first in WRAPPERS || first === 'git' || SHELLS.has(first) || INTERPRETER_RE.test(first))) return `runs ${first} with arguments that aren't a literal list`;
    const resolved = unwrap(command, words);
    if (resolved === null) return stringsReason(strings);
    if ('stop' in resolved) return resolved.stop;
    const { runs, rest } = resolved;
    if (runs === 'git') {
        const git = gitReason(rest);
        if (git) return git;
    }
    if (DELETE_COMMANDS.has(runs)) return `runs ${runs}`;
    if (runs === 'find' && rest.includes('-delete')) return 'runs find -delete';
    const family = INTERPRETER_RE.exec(runs)?.[1];
    if (family) {
        const flag = rest.findIndex((each) => each !== null && SCRIPT_FLAGS[family].includes(each));
        const script = flag >= 0 ? rest[flag + 1] : undefined;
        const isNode = family === 'node' || family === 'nodejs';
        // node with only literal arguments and no script, such as `node --version`, runs a file the rail scans, or nothing.
        if (flag < 0 && isNode && rest.every((each) => each !== null)) return stringsReason(strings);
        if (flag < 0 && isNode) return `runs ${runs} with arguments that aren't literals`;
        if (flag < 0) return `runs ${runs} with no literal script, so it may read one from stdin or a file`;
        if (script === null || script === undefined) return `runs a ${runs} script that isn't a literal`;
        if (family !== 'node' && family !== 'nodejs') return `runs a ${runs} script, which the rail can't read`;
        // A node script is JavaScript: the rail reads it as it reads a file.
        const [inner] = scanSource(`${runs} -e`, script);
        if (inner) return `runs ${runs} -e with ${inner.call}`;
    }
    if (SHELLS.has(runs)) {
        const flag = rest.findIndex((each) => each !== null && /^-\w*c\w*$/.test(each));
        if (flag < 0) return `runs ${runs} with no literal script, so it may read one from stdin or a file`;
        const script = rest[flag + 1];
        if (script === null || script === undefined) return "runs a shell script that isn't a literal";
        // The script is read as a command line, so what it runs is judged as a list would be: a nested node -e, python -c or sh -s included.
        for (const words of shellCommands(script)) {
            const nested = wordsReason(words[0], words.slice(1), true, words);
            if (nested) return nested;
        }
    }
    const said = stringsReason(strings);
    if (said) return said;
    if (SHELLS.has(runs) && rest.some((each) => each === null)) return `runs ${runs} with arguments that aren't literals`;
    return null;
}

/**
 * Why a child_process call deletes, or might, or can't be read. Null when
 * it plainly doesn't. A form it can't resolve fails the rail closed (#181's
 * A10 review, items 24, 27 and 31). An exec string is split into its
 * commands and words and judged as a list would be.
 */
function processReason(node: ts.CallExpression, fn: string): string | null {
    const shellString = SHELL_STRING.has(fn);
    const options = optionsOf(node, shellString);
    const args = node.arguments.filter((each) => each !== options && !ts.isArrowFunction(each) && !ts.isFunctionExpression(each));
    // What the options feed the command on stdin counts as its text too.
    const input = options && ts.isObjectLiteralExpression(options) ? options.properties.filter((each) => ts.isPropertyAssignment(each) && keyText(each.name) === 'input').map((each) => (each as ts.PropertyAssignment).initializer) : [];
    const strings = [...allStrings(args), ...allStrings(input)];
    const [command, list] = args;
    const listLiteral = shellString || list === undefined || ts.isArrayLiteralExpression(list);
    const elements: readonly ts.Expression[] = !shellString && list && ts.isArrayLiteralExpression(list) ? list.elements : [];
    const nonLiteral = !isLiteral(command) || !listLiteral || elements.some((each) => !isLiteral(each));
    const unread = (): string | null => {
        const shell = shellRead(options);
        if (!nonLiteral || shell === 'none') return null;
        return shell === 'true' ? "with shell: true and arguments that aren't literals" : "with options the rail can't read, and arguments that aren't literals";
    };
    if (!isLiteral(command)) return stringsReason(strings) ?? "with a command that isn't a literal";
    if (shellString) {
        const said = stringsReason(strings);
        if (said) return said;
        for (const words of shellCommands(command.text)) {
            const reason = wordsReason(words[0], words.slice(1), true, words);
            if (reason) return reason;
        }
        return unread();
    }
    return wordsReason(command.text, elements.map((each) => (isLiteral(each) ? each.text : null)), listLiteral, strings) ?? unread();
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
        // A re-export hands fs or child_process to modules the rail doesn't follow.
        if (ts.isExportDeclaration(node) && module !== null && (FS_MODULES.has(module) || PROCESS_MODULES.has(module))) add(node, `re-exports ${module}`);
        const loading = loader(node, known);
        if (loading && !isLiteral(loading.specifier)) add(node, `${loading.kind} of a module that isn't a literal`);
        if (loading && isLiteral(loading.specifier) && /^data:/i.test(loading.specifier.text)) add(node, `${loading.kind} of a data: URL, which the rail can't read`);
        // The escape rule, for a load of fs or child_process.
        if (loading && module !== null && (FS_MODULES.has(module) || PROCESS_MODULES.has(module)) && !allowedUse(node as ts.Expression, true, loading.kind === 'import()')) add(node, `escapes ${node.getText(source)}`);
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name !== null && DELETE_NAMES.has(name)) add(node, node.expression.getText(source));
            if (name !== null && VM_NAMES.has(name)) add(node, `${node.expression.getText(source)}, which the rail can't read`);
            const fn = processFunction(node.expression, known);
            if (fn) {
                const reason = processReason(node, fn);
                if (reason) add(node, `${node.expression.getText(source)} ${reason}`);
                node.arguments.forEach((argument) => inProcessArgs.add(argument));
            }
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === 'Reflect.get' && node.arguments[0] && (isFsObject(node.arguments[0], known) || isProcessObject(node.arguments[0], known))) {
                add(node, `${callee.getText(source)}(${node.arguments[0].getText(source)}, …)`);
            }
            // Reflect.get on the global object reaches eval and everything else on it.
            const first = node.arguments[0] ? bare(node.arguments[0]) : undefined;
            if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === 'Reflect.get' && first && ts.isIdentifier(first) && GLOBALS.has(first.text)) {
                add(node, `${callee.getText(source)}(${first.text}, …), which the rail can't read`);
            }
            if (ts.isIdentifier(callee) && callee.text === 'Function') add(node, "Function, which the rail can't read");
        } else if (ts.isNewExpression(node)) {
            const created = bare(node.expression);
            const named = ts.isIdentifier(created) ? created.text : ts.isPropertyAccessExpression(created) ? created.name.text : null;
            if (named === 'Function') add(node, `new ${node.expression.getText(source)}, which the rail can't read`);
            // node:vm's Script and modules, only when node:vm's: a class of one's own named Script is nothing.
            const fromVm = (ts.isIdentifier(created) && known.vmClasses.has(created.text)) || (ts.isPropertyAccessExpression(created) && VM_CLASSES.has(created.name.text) && ts.isIdentifier(created.expression) && known.vmObjects.has(created.expression.text));
            if (fromVm) add(node, `new ${node.expression.getText(source)}, which the rail can't read`);
            // Anything made with eval in its options, a Worker however it's reached or aliased; and a Worker whose options the rail can't read.
            const options = node.arguments?.[1];
            const evaluated = options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some((each) => (named === 'Worker' && (ts.isSpreadAssignment(each) || keyText(each.name) === null)) || (!ts.isSpreadAssignment(each) && keyText(each.name) === 'eval' && !(ts.isPropertyAssignment(each) && each.initializer.kind === ts.SyntaxKind.FalseKeyword)));
            if (evaluated || (named === 'Worker' && options !== undefined && !ts.isObjectLiteralExpression(options))) add(node, `new ${node.expression.getText(source)} with eval, which the rail can't read`);
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            if (!isCallee(node)) add(node, node.getText(source));
        } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'eval' && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text)) {
            add(node, `${node.getText(source)}, which the rail can't read`);
        } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text) && isLiteral(node.argumentExpression) && node.argumentExpression.text === 'eval') {
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
            else if (key === null && from && (isFsObject(from, known) || isProcessObject(from, known))) add(node, `computed destructure ${node.getText(source)}`);
        } else if (ts.isIdentifier(node) && node.text === 'eval' && !isDeclarationName(node) && !inType(node)) {
            // eval in any form, direct or indirect, such as (0, eval)(…).
            add(node, "eval, which the rail can't read");
        } else if (!inProcessArgs.has(node)) {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
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
