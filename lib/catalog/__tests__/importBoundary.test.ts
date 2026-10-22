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

const NEXT_SERVER = "import { connection } from 'next/server';\nexport const probe = connection;\n";
const SERVER_ONLY = "import 'server-only';\nexport const probe = 1;\n";

describe('the lib/catalog import boundary', { timeout: 60_000 }, () => {
    it.each([
        ['lib/catalog/reader.ts', NEXT_SERVER],
        ['lib/catalog/working-layer.ts', SERVER_ONLY],
        ['lib/catalog/projections/home.ts', "import { cache } from 'next/dist/server/lib/cache';\nexport const probe = cache;\n"],
        ['lib/catalog/__tests__/probe.test.ts', NEXT_SERVER],
    ])('rejects %s importing Next or server-only', async (file, source) => {
        expect(await restrictedImports(file, source)).toHaveLength(1);
    });

    it.each([
        ['lib/catalog/request.ts', NEXT_SERVER],
        ['lib/catalog/public-reader.ts', `${SERVER_ONLY}${NEXT_SERVER.replace('probe', 'other')}`],
    ])('lets %s, which only the web process imports, use them', async (file, source) => {
        expect(await restrictedImports(file, source)).toEqual([]);
    });

    it('allows React, zod, and Node imports anywhere in lib/catalog', async () => {
        expect(await restrictedImports('lib/catalog/reader.ts', "import { cache } from 'react';\nimport { z } from 'zod';\nimport fs from 'node:fs';\nexport const probe = [cache, z, fs];\n")).toEqual([]);
    });
});
