// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { shippedFiles } from '../../test/helpers/deleteCalls';
import { REPO_ROOT } from '../../test/helpers/runTsx';
import { globalSlot, slotKey } from '../globalSlot';

/** Every slot key declared in `file`: `const NAME = slotKey<T>(Symbol.for('name'))`, by its variable, with its Symbol.for() name. */
function slotKeys(source: ts.SourceFile): Map<string, string> {
    const keys = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
            const call = node.initializer;
            const inner = call.arguments[0];
            if (
                ts.isIdentifier(call.expression) && call.expression.text === 'slotKey' && call.arguments.length === 1 &&
                ts.isCallExpression(inner) && inner.expression.getText(source) === 'Symbol.for' && inner.arguments.length === 1 && ts.isStringLiteral(inner.arguments[0])
            ) keys.set(node.name.text, inner.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return keys;
}

/** Every globalSlot() call in `source`, by the text of the key it passes. */
function slotCalls(source: ts.SourceFile): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'globalSlot') found.push(node.arguments[0]?.getText(source) ?? '');
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe('globalSlot()', () => {
    it('keeps one value per key, made once, at the Symbol.for() key itself', () => {
        const KEY = slotKey<{ count: number }>(Symbol.for('keyurgolani.photography.test.globalSlot.once'));
        expect(KEY).toBe(Symbol.for('keyurgolani.photography.test.globalSlot.once'));
        let made = 0;
        const first = globalSlot(KEY, () => ({ count: ++made }));
        const again = globalSlot(KEY, () => ({ count: ++made }));
        expect(again).toBe(first);
        expect(made).toBe(1);
        expect((globalThis as unknown as Record<symbol, unknown>)[Symbol.for('keyurgolani.photography.test.globalSlot.once')]).toBe(first);
    });

    it("ties each key to its value's type, so a wrong-typed slot doesn't compile", () => {
        const NUMBERS = slotKey<number>(Symbol.for('keyurgolani.photography.test.globalSlot.numbers'));
        const NAMES = slotKey<Set<string>>(Symbol.for('keyurgolani.photography.test.globalSlot.names'));
        expectTypeOf(globalSlot(NUMBERS, () => 1)).toEqualTypeOf<number>();
        expectTypeOf(globalSlot(NAMES, () => new Set<string>())).toEqualTypeOf<Set<string>>();
        // Only type-checked, never run, so no slot is made under these keys.
        const pins = () => {
            // @ts-expect-error A bare symbol names no type, so it can't key a slot.
            globalSlot(Symbol.for('keyurgolani.photography.test.globalSlot.bare'), () => 1);
            // @ts-expect-error The init must make the key's type.
            globalSlot(NUMBERS, () => 'one');
            // @ts-expect-error The slot can't be read as another type.
            globalSlot<string>(NUMBERS, () => 'one');
            // @ts-expect-error Nor as a wider one, which would let a caller put another kind of value in.
            globalSlot<ReadonlySet<string> | string[]>(NAMES, () => []);
        };
        expect(pins).toBeTypeOf('function');
    });

    it('keys every slot in shipped code with a typed key its own file makes, and no two slots share a name', () => {
        const names: string[] = [];
        const problems: string[] = [];
        for (const file of shippedFiles().filter((each) => !each.endsWith('.sh') && each !== 'lib/globalSlot.ts')) {
            const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
            if (!text.includes('globalSlot')) continue;
            const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
            const keys = slotKeys(source);
            for (const key of slotCalls(source)) if (!keys.has(key)) problems.push(`${file}: globalSlot(${key}) isn't keyed by a slotKey() this file makes`);
            names.push(...keys.values());
        }
        expect(problems).toEqual([]);
        // The seven slots today: catalog cutover, preview reader, Home's test pick, curator login and sessions, and the About portrait's two.
        expect(names).toHaveLength(7);
        expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    });
});
