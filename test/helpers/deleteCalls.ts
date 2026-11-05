/**
 * The delete-call rail (#181's A10 review): every call in the source tree
 * that can delete a file or a folder, with the file and the named function
 * it sits in, so a test can hold them to an allowlist. It reads the source
 * with the TypeScript parser and runs nothing.
 *
 * It finds `rm`, `rmSync`, `rmdir`, `unlink`, `unlinkSync`, `rimraf`,
 * `remove`, `emptyDir` and their kin however they're reached
 * (`fs.promises.rm`, `fs['rm']`, a destructured or imported `rm`, one passed
 * on as a value, computed access on `fs`, or `Reflect.get(fs, …)`), any
 * import of `rimraf`, `del`, `fs-extra` or `trash`, a `child_process` call
 * that runs `rm`, `git clean` or `find -delete` in any of its arguments, or
 * whose command or shell script isn't a literal, and `-delete` in any other
 * string. Overwriting renames and copies onto existing paths are out of its
 * scope.
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

const DELETE_NAMES = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rimraf', 'rimrafSync', 'unlinkat', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync']);
/** Packages whose job is deleting files, and any subpath of one. Any import, re-export or require of one is a delete. */
const DELETE_MODULE_RE = /^(?:rimraf|del|fs-extra|trash)(?:\/|$)/;
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const PROCESS_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Interpreters, and the flags that take a script to run. */
const INTERPRETERS: Record<string, readonly string[]> = { node: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], python: ['-c'], python3: ['-c'], ruby: ['-e'], bun: ['-e', '--eval'], deno: ['eval'] };
/** `rm`, `rmdir` or `unlink` as a shell command: bare, by path, escaped with `\`, or quoted. */
const SHELL_DELETE = /(?:^|[\s;&|(`])\\?(["']?)(?:\/(?:usr\/)?bin\/)?(rm|rmdir|unlink)\1(?=$|[\s;&|)])/;
/** `git`, with any options, then `clean`. */
const GIT_CLEAN = /(?:^|[\s;&|(`])git\b[^;&|\n]*?\sclean\b/;
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

/** What a file binds to child_process, to fs, and to a `require` made by `createRequire()`. */
interface Bindings {
    processNames: Set<string>;
    processObjects: Set<string>;
    fsObjects: Set<string>;
    requireNames: Set<string>;
}

/** A call that loads a module: `require(x)`, `import(x)`, a `createRequire()` require, or `createRequire(…)(x)`. Null for any other call. */
function loader(node: ts.Node, known: Bindings): { kind: 'require' | 'import()'; specifier: ts.Expression | undefined } | null {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return { kind: 'import()', specifier: node.arguments[0] };
    if (ts.isIdentifier(callee) && (callee.text === 'require' || known.requireNames.has(callee.text))) return { kind: 'require', specifier: node.arguments[0] };
    if (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire') return { kind: 'require', specifier: node.arguments[0] };
    return null;
}

/** The module a loading call names as a literal, or null. */
function loadedModule(node: ts.Node, known: Bindings): string | null {
    const loaded = loader(ts.isExpression(node) ? bare(node) : node, known);
    return loaded && isLiteral(loaded.specifier) ? loaded.specifier.text : null;
}

/** Whether `node` is fs, `fs.promises`, an alias of either, or a `require('fs')`. */
function isFsObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.fsObjects.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'promises') return isFsObject(expression.expression, known);
    return FS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` is child_process, an alias of it, or a `require('child_process')`. */
function isProcessObject(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processObjects.has(expression.text);
    return PROCESS_MODULES.has(loadedModule(expression, known) ?? '');
}

/** Whether `node` names a child_process function: `spawn`, `cp.exec`, or one bound from either. */
function isProcessFunction(node: ts.Expression, known: Bindings): boolean {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return known.processNames.has(expression.text);
    return ts.isPropertyAccessExpression(expression) && PROCESS_NAMES.has(expression.name.text) && isProcessObject(expression.expression, known);
}

/** The key a binding element takes: `rm` for `{ rm }`, `{ rm: r }` and `{ ['rm']: r }`, or null for a computed key that isn't a literal. */
function bindingKey(element: ts.BindingElement, source: ts.SourceFile): string | null {
    const key = element.propertyName ?? element.name;
    if (ts.isComputedPropertyName(key)) return isLiteral(key.expression) ? key.expression.text : null;
    return key.getText(source);
}

/**
 * Every name a file binds to child_process, to fs, and to a `createRequire()`
 * require, through imports, `import x = require()`, `require()`, `await
 * import()`, destructuring, plain aliases and `promisify()`, until nothing
 * new turns up.
 */
function bindings(source: ts.SourceFile): Bindings {
    const known: Bindings = { processNames: new Set(), processObjects: new Set(), fsObjects: new Set(['fs', 'fsp']), requireNames: new Set() };
    const size = () => known.processNames.size + known.processObjects.size + known.fsObjects.size + known.requireNames.size;
    const bindModule = (module: string, name: ts.BindingName | undefined, named: { local: string; imported: string }[], namespace?: string) => {
        const objects = PROCESS_MODULES.has(module) ? known.processObjects : FS_MODULES.has(module) ? known.fsObjects : null;
        if (objects === null) return;
        if (name && ts.isIdentifier(name)) objects.add(name.text);
        if (namespace) objects.add(namespace);
        for (const { local, imported } of named) {
            if (PROCESS_MODULES.has(module) && PROCESS_NAMES.has(imported)) known.processNames.add(local);
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
            if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'createRequire' && ts.isIdentifier(node.name)) known.requireNames.add(node.name.text);
            if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'promisify' && init.arguments[0] && isProcessFunction(init.arguments[0], known) && ts.isIdentifier(node.name)) known.processNames.add(node.name.text);
            if (isProcessObject(init, known)) {
                if (ts.isIdentifier(node.name)) known.processObjects.add(node.name.text);
                for (const { local, imported } of destructured(node.name)) if (PROCESS_NAMES.has(imported)) known.processNames.add(local);
            }
            if (isProcessFunction(init, known) && ts.isIdentifier(node.name)) known.processNames.add(node.name.text);
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

/** A process call's options, its last argument when that is an object literal. */
function optionsOf(node: ts.CallExpression): ts.ObjectLiteralExpression | null {
    const last = node.arguments[node.arguments.length - 1];
    return last && node.arguments.length > 1 && ts.isObjectLiteralExpression(last) ? last : null;
}

/** Whether a process call's options turn `shell` on, or might. */
function shellOn(node: ts.CallExpression): boolean {
    const options = optionsOf(node);
    const shell = options?.properties.find((each) => ts.isPropertyAssignment(each) && each.name.getText() === 'shell');
    return shell !== undefined && ts.isPropertyAssignment(shell) && shell.initializer.kind !== ts.SyntaxKind.FalseKeyword;
}

/**
 * Why a child_process call deletes, or might, or can't be read: it runs rm,
 * rmdir, unlink, git clean or find -delete in any of its arguments, or what
 * it runs isn't a literal. Null when it plainly doesn't. A form it can't
 * resolve fails the rail closed (#181's A10 review, item 24).
 */
function processReason(node: ts.CallExpression): string | null {
    const options = optionsOf(node);
    const args = node.arguments.filter((each) => each !== options);
    const strings = allStrings(args);
    const deleting = strings.map((text) => SHELL_DELETE.exec(text)).find((match) => match !== null);
    if (deleting) return `runs ${deleting[2]}`;
    const [command, list] = args;
    const commandText = isLiteral(command) ? command.text : null;
    let elements: readonly ts.Expression[] = list && ts.isArrayLiteralExpression(list) ? list.elements : [];
    const listLiteral = list === undefined || ts.isArrayLiteralExpression(list);
    const words = elements.flatMap((each) => (isLiteral(each) ? [each.text] : []));
    if (strings.some((text) => GIT_CLEAN.test(text)) || (commandText !== null && path.posix.basename(commandText) === 'git' && words.includes('clean'))) return 'runs git clean';
    if (strings.some((text) => FIND_DELETE.test(text))) return 'runs find -delete';
    if (commandText === null) return "with a command that isn't a literal";
    let runs = path.posix.basename(commandText);
    if (!listLiteral && (runs === 'git' || runs === 'env' || SHELLS.has(runs) || runs in INTERPRETERS)) return `runs ${runs} with arguments that aren't a literal list`;
    if (runs === 'env') {
        // `env [-i] [NAME=value…] command args…`: judge what it runs.
        const at = elements.findIndex((each) => !isLiteral(each) || (!each.text.startsWith('-') && !each.text.includes('=')));
        const next = at >= 0 ? elements[at] : undefined;
        if (next === undefined) return null;
        if (!isLiteral(next)) return "runs env with a command that isn't a literal";
        runs = path.posix.basename(next.text);
        elements = elements.slice(at + 1);
    }
    const scriptFlags = SHELLS.has(runs) ? null : INTERPRETERS[runs];
    if (SHELLS.has(runs) || scriptFlags) {
        const flag = elements.findIndex((each) => isLiteral(each) && (scriptFlags ? scriptFlags.includes(each.text) : /^-\w*c\w*$/.test(each.text)));
        if (flag >= 0 && !isLiteral(elements[flag + 1])) return SHELLS.has(runs) ? "runs a shell script that isn't a literal" : `runs a ${runs} script that isn't a literal`;
        if (elements.some((each) => !isLiteral(each))) return `runs ${runs} with arguments that aren't literals`;
    }
    if (shellOn(node) && (!listLiteral || elements.some((each) => !isLiteral(each)))) return "with shell: true and arguments that aren't literals";
    return null;
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
    const isCallee = (node: ts.Node) => ts.isCallExpression(node.parent) && node.parent.expression === node;
    const visit = (node: ts.Node) => {
        let module: string | null = null;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) module = node.moduleSpecifier.text;
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLiteral(node.moduleReference.expression)) module = node.moduleReference.expression.text;
        else module = loadedModule(node, known);
        if (module !== null && DELETE_MODULE_RE.test(module)) add(node, `module ${module}`);
        const loading = loader(node, known);
        if (loading && !isLiteral(loading.specifier)) add(node, `${loading.kind} of a module that isn't a literal`);
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name !== null && DELETE_NAMES.has(name)) add(node, node.expression.getText(source));
            if (isProcessFunction(node.expression, known)) {
                const reason = processReason(node);
                if (reason) add(node, `${node.expression.getText(source)} ${reason}`);
                node.arguments.forEach((argument) => inProcessArgs.add(argument));
            }
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Reflect' && node.arguments[0] && isFsObject(node.arguments[0], known)) {
                add(node, `${callee.getText(source)}(${node.arguments[0].getText(source)}, …)`);
            }
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            if (!isCallee(node)) add(node, node.getText(source));
        } else if (ts.isElementAccessExpression(node)) {
            const key = node.argumentExpression;
            if (isLiteral(key) && DELETE_NAMES.has(key.text) && !isCallee(node)) add(node, node.getText(source));
            else if (!isLiteral(key) && isFsObject(node.expression, known)) add(node, `computed access ${node.getText(source)}`);
        } else if (ts.isImportSpecifier(node) && DELETE_NAMES.has((node.propertyName ?? node.name).getText(source))) {
            add(node, `import ${node.getText(source)}`);
        } else if (ts.isBindingElement(node)) {
            const key = bindingKey(node, source);
            const from = ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.initializer : undefined;
            if (key !== null && DELETE_NAMES.has(key)) add(node, `destructure ${node.getText(source)}`);
            else if (key === null && from && isFsObject(from, known)) add(node, `computed destructure ${node.getText(source)}`);
        } else if (!inProcessArgs.has(node)) {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
        // A child_process function handed on to anything but promisify(), which the bindings follow, can't be read.
        if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && !isCallee(node) && isProcessFunction(node as ts.Expression, known)) {
            const parent = node.parent;
            const declared = ts.isImportSpecifier(parent) || ts.isBindingElement(parent) || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node) || (ts.isPropertyAccessExpression(parent) && parent.name === node);
            const promisified = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'promisify';
            if (!declared && !promisified) add(node, `passes on ${node.getText(source)}`);
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
