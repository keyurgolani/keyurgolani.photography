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
/** Packages whose job is deleting files. Any import of one is a delete. */
const DELETE_MODULES = new Set(['rimraf', 'del', 'fs-extra', 'trash']);
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const PROCESS_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', '/bin/sh', '/bin/bash', '/bin/zsh']);
/** `rm` as a shell command, bare or by path. */
const SHELL_RM = /^(?:\/(?:usr\/)?bin\/)?rm$|(?:^|[\s;&|(`])(?:\/(?:usr\/)?bin\/)?rm\s/;
/** `git clean`. */
const GIT_CLEAN = /(?:^|[\s;&|(`])git\s+clean\b/;
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

/** The module a `require('x')` or `import('x')` call names, or null. */
function requiredModule(node: ts.Node): string | null {
    if (!ts.isCallExpression(node) || !isLiteral(node.arguments[0])) return null;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) return node.arguments[0].text;
    return null;
}

export function parse(file: string, text: string): ts.SourceFile {
    const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : /\.(?:ts|mts|cts)(?:\.txt)?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** The names a file binds to child_process and to fs: named imports by their local name, and namespaces and defaults. */
function bindings(source: ts.SourceFile): { processNames: Set<string>; processObjects: Set<string>; fsObjects: Set<string> } {
    const processNames = new Set<string>();
    const processObjects = new Set<string>();
    const fsObjects = new Set<string>(['fs', 'fsp']);
    const bind = (module: string, clause: { name?: ts.Identifier; namespace?: string; named: { local: string; imported: string }[] }) => {
        if (PROCESS_MODULES.has(module)) {
            if (clause.name) processObjects.add(clause.name.text);
            if (clause.namespace) processObjects.add(clause.namespace);
            for (const { local, imported } of clause.named) if (PROCESS_NAMES.has(imported)) processNames.add(local);
        }
        if (FS_MODULES.has(module)) {
            if (clause.name) fsObjects.add(clause.name.text);
            if (clause.namespace) fsObjects.add(clause.namespace);
            for (const { local, imported } of clause.named) if (imported === 'promises') fsObjects.add(local);
        }
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && isLiteral(node.moduleSpecifier) && node.importClause) {
            const { name, namedBindings } = node.importClause;
            bind(node.moduleSpecifier.text, {
                name,
                namespace: namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings.name.text : undefined,
                named: namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements.map((each) => ({ local: each.name.text, imported: (each.propertyName ?? each.name).text })) : [],
            });
        }
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const module = requiredModule(node.initializer);
            if (module !== null) {
                bind(module, {
                    name: ts.isIdentifier(node.name) ? node.name : undefined,
                    named: ts.isObjectBindingPattern(node.name) ? node.name.elements.map((each) => ({ local: each.name.getText(source), imported: (each.propertyName ?? each.name).getText(source) })) : [],
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { processNames, processObjects, fsObjects };
}

/** Why a child_process call deletes, or might: it runs rm, git clean or find -delete, or what it runs isn't a literal. Null when it plainly doesn't. */
function processReason(node: ts.CallExpression): string | null {
    const strings = allStrings(node.arguments);
    const [command, list] = node.arguments;
    const commandText = isLiteral(command) ? command.text : null;
    const listed = list && ts.isArrayLiteralExpression(list) ? list.elements : [];
    const literals = listed.filter(isLiteral).map((each) => each.text);
    if (strings.some((text) => SHELL_RM.test(text))) return 'runs rm';
    if (strings.some((text) => GIT_CLEAN.test(text)) || (commandText === 'git' && literals.includes('clean'))) return 'runs git clean';
    if (strings.some((text) => FIND_DELETE.test(text))) return 'runs find -delete';
    if (commandText === null) return "with a command that isn't a literal";
    if (SHELLS.has(commandText)) {
        const index = listed.findIndex((each) => isLiteral(each) && /^-\w*c\w*$/.test(each.text));
        if (index >= 0 && !isLiteral(listed[index + 1])) return "runs a shell script that isn't a literal";
    }
    return null;
}

/** Every delete call in one source text. `file` is how findings name it. */
export function scanSource(file: string, text: string): DeleteCall[] {
    const source = parse(file, text);
    const { processNames, processObjects, fsObjects } = bindings(source);
    const found: DeleteCall[] = [];
    const add = (node: ts.Node, call: string) => {
        found.push({ file, fn: enclosingFunction(node), call, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    };
    const isProcessCall = (node: ts.CallExpression) => {
        const callee = node.expression;
        if (ts.isIdentifier(callee)) return processNames.has(callee.text);
        if (!ts.isPropertyAccessExpression(callee) || !PROCESS_NAMES.has(callee.name.text)) return false;
        const object = callee.expression;
        return (ts.isIdentifier(object) && processObjects.has(object.text)) || PROCESS_MODULES.has(requiredModule(object) ?? '');
    };
    const isFsObject = (node: ts.Expression) => (ts.isIdentifier(node) && fsObjects.has(node.text)) || (ts.isPropertyAccessExpression(node) && node.name.text === 'promises' && ts.isIdentifier(node.expression) && fsObjects.has(node.expression.text));
    /** Strings a process call's arguments hold are judged there, once. */
    const inProcessArgs = new Set<ts.Node>();
    const visit = (node: ts.Node) => {
        const module = ts.isImportDeclaration(node) && isLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLiteral(node.moduleReference.expression) ? node.moduleReference.expression.text : requiredModule(node);
        if (module !== null && DELETE_MODULES.has(module)) add(node, `module ${module}`);
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name !== null && DELETE_NAMES.has(name)) add(node, node.expression.getText(source));
            if (isProcessCall(node)) {
                const reason = processReason(node);
                if (reason) add(node, `${node.expression.getText(source)} ${reason}`);
                node.arguments.forEach((argument) => inProcessArgs.add(argument));
            }
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Reflect' && node.arguments[0] && isFsObject(node.arguments[0])) {
                add(node, `${callee.getText(source)}(${node.arguments[0].getText(source)}, …)`);
            }
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
            if (!called) add(node, node.getText(source));
        } else if (ts.isElementAccessExpression(node)) {
            const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
            const key = node.argumentExpression;
            if (isLiteral(key) && DELETE_NAMES.has(key.text) && !called) add(node, node.getText(source));
            else if (!isLiteral(key) && isFsObject(node.expression)) add(node, `computed access ${node.getText(source)}`);
        } else if ((ts.isImportSpecifier(node) || ts.isBindingElement(node)) && DELETE_NAMES.has((node.propertyName ?? node.name).getText(source))) {
            add(node, `${ts.isImportSpecifier(node) ? 'import' : 'destructure'} ${node.getText(source)}`);
        } else if (!inProcessArgs.has(node)) {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
        if (inProcessArgs.has(node)) ts.forEachChild(node, (child) => void inProcessArgs.add(child));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** Every delete call in a shell script, line by line. */
function scanShell(file: string, text: string): DeleteCall[] {
    return text.split('\n').flatMap((line, index) => (!/^\s*#/.test(line) && (SHELL_RM.test(line.trim()) || FIND_DELETE.test(line)) ? [{ file, fn: '<shell>', call: line.trim(), line: index + 1 }] : []));
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
