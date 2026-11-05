/**
 * The delete-call rail (#181's A10 review): every call in the source tree
 * that can delete a file or a folder, with the file and the named function
 * it sits in, so a test can hold them to an allowlist. It reads the source
 * with the TypeScript parser and runs nothing.
 *
 * It finds `rm`, `rmSync`, `rmdir`, `unlink`, `unlinkSync`, `rimraf` and
 * their kin however they're reached (`fs.promises.rm`, `fs['rm']`, a
 * destructured or imported `rm`, or one passed on as a value), a
 * `child_process` call that runs `rm`, and `find`'s `-delete` in any string.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './runTsx';

export interface DeleteCall {
    /** Relative to the repository root, with `/`. */
    file: string;
    /** The named functions it sits in, outermost first, joined with `.`, or `<module>`. */
    fn: string;
    /** What it calls, as written. */
    call: string;
    line: number;
}

const DELETE_NAMES = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rimraf', 'rimrafSync', 'unlinkat']);
const PROCESS_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** `rm` as a shell command, bare or by path. */
const SHELL_RM = /^(?:\/(?:usr\/)?bin\/)?rm$|(?:^|[\s;&|(`])(?:\/(?:usr\/)?bin\/)?rm\s/;
/** `find ... -delete`. */
const FIND_DELETE = /(?:^|\s)-delete\b/;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** A function's name, where it has one: its own, or the variable, property or method it's assigned to. */
function nameOf(node: ts.Node): string | null {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText();
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
        if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText();
    }
    return null;
}

/** The named functions around `node`, outermost first, as `runGc.held`. Anonymous ones are passed over. */
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

function stringText(node: ts.Node): string | null {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    return null;
}

export function parse(file: string, text: string): ts.SourceFile {
    const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every delete call in one source text. `file` is how findings name it. */
export function scanSource(file: string, text: string): DeleteCall[] {
    const source = parse(file, text);
    const found: DeleteCall[] = [];
    const add = (node: ts.Node, call: string) => {
        found.push({ file, fn: enclosingFunction(node), call, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    };
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name !== null && DELETE_NAMES.has(name)) add(node, node.expression.getText(source));
            if (name !== null && PROCESS_NAMES.has(name)) {
                const command = node.arguments.map(stringText).find((each) => each !== null);
                if (command && (SHELL_RM.test(command) || FIND_DELETE.test(command))) add(node, `${node.expression.getText(source)}(${JSON.stringify(command)})`);
            }
        } else if (ts.isPropertyAccessExpression(node) && DELETE_NAMES.has(node.name.text)) {
            // Passed on as a value, such as `.then(fs.promises.rm)`, rather than called here.
            const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
            if (!called) add(node, node.getText(source));
        } else if ((ts.isImportSpecifier(node) || ts.isBindingElement(node)) && DELETE_NAMES.has((node.propertyName ?? node.name).getText(source))) {
            add(node, `${ts.isImportSpecifier(node) ? 'import' : 'destructure'} ${node.getText(source)}`);
        } else {
            const text = stringText(node);
            if (text !== null && FIND_DELETE.test(text)) add(node, '-delete');
        }
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
