// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

// ESLint 9.9 ships no type declarations, so describe the slice of its API this test uses.
interface LintMessage {
    ruleId: string | null;
    message: string;
}
interface LintApi {
    lintText(code: string, options: { filePath: string }): Promise<{ messages: LintMessage[] }[]>;
}
const { ESLint } = createRequire(import.meta.url)('eslint') as { ESLint: new (options: { cwd: string }) => LintApi };

let eslint: LintApi;

beforeAll(() => {
    eslint = new ESLint({ cwd: REPO_ROOT });
});

async function restrictedImports(relativePath: string, source: string): Promise<string[]> {
    const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, relativePath) });
    return result.messages.filter((message) => message.ruleId === 'no-restricted-imports').map((message) => message.message);
}

describe('the lib/storage and lib/identity import boundary', { timeout: 60_000 }, () => {
    it.each([
        ['lib/storage/probe.ts', "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n"],
        ['lib/identity/probe.ts', "import { headers } from 'next/headers';\nexport const probe = headers;\n"],
        ['lib/identity/nested/probe.ts', "import type { NextConfig } from 'next';\nexport type Probe = NextConfig;\n"],
        ['lib/storage/probe.ts', "import 'server-only';\nexport const probe = 1;\n"],
        ['lib/identity/probe.ts', "export { NextResponse } from 'next/server';\n"],
    ])('rejects %s importing %j', async (file, source) => {
        expect(await restrictedImports(file, source)).toHaveLength(1);
    });

    it('allows Node and library imports there', async () => {
        expect(await restrictedImports('lib/storage/probe.ts', "import fs from 'node:fs';\nimport sharp from 'sharp';\nexport const probe = [fs, sharp];\n")).toEqual([]);
    });

    it('leaves Next imports alone elsewhere', async () => {
        expect(await restrictedImports('app/probe.ts', "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n")).toEqual([]);
        expect(await restrictedImports('proxy.ts', "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n")).toEqual([]);
    });
});
