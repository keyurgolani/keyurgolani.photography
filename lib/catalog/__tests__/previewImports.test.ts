// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

// #16's containment rule in eslint.config.js: only app/curation/** and
// lib/catalog/** import the preview reader, which reads drafts, and nothing
// under the preview imports the public reader.

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

const importing = (specifier: string) => `import { probe } from '${specifier}';\nexport const used = probe;\n`;

/** What either rule reports: no-restricted-imports for static imports and exports, no-restricted-syntax for every other load. */
async function restrictedLoads(relativePath: string, source: string): Promise<string[]> {
    const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, relativePath) });
    return result.messages.filter((message) => message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax').map((message) => message.message);
}

/** Every way a file can load `specifier`, beyond the plain static import. */
const loads = (specifier: string): [string, string][] => [
    ['export *', `export * from '${specifier}';\n`],
    ['export from', `export { probe } from '${specifier}';\n`],
    ['import()', `export const probe = () => import('${specifier}');\n`],
    ['import() of a template', `export const probe = () => import(\`${specifier}\`);\n`],
    ['import() of a template ending in the path', `const base = '@/lib';\nexport const probe = () => import(\`\${base}/${specifier.replace(/^.*?(catalog\/)/, '$1')}\`);\n`],
    ['require()', `export const probe = require('${specifier}');\n`],
    ['a created require()', `import { createRequire } from 'node:module';\nexport const probe = createRequire(import.meta.url)('${specifier}');\n`],
    ['vi.mock()', `import { vi } from 'vitest';\nvi.mock('${specifier}');\n`],
    ['import = require()', `import probe = require('${specifier}');\nexport const used = probe;\n`],
];

/** Specifiers that resolve to `lib/catalog/<name>.ts` as well as the plain one. */
const spellings = (prefix: string, name: string) => [
    `${prefix}/${name}.js`,
    `${prefix}/${name}.ts`,
    `${prefix}/${name}.mjs`,
    `${prefix}/${name}/`,
    `${prefix}//${name}`,
    `${prefix}/./${name}`,
    `${prefix.replace(/catalog$/, 'Catalog')}/${name.toUpperCase()}`,
];

describe("#16's preview reader import rule", { timeout: 60_000 }, () => {
    it.each([
        ['components/home/Probe.tsx', '@/lib/catalog/preview-reader'],
        ['components/site/probe.ts', '../../lib/catalog/preview-reader'],
        ['app/page.tsx', '@/lib/catalog/preview-reader'],
        ['app/work/[slug]/page.tsx', '@/lib/catalog/preview-reader.ts'],
        ['app/api/catalog/series/[slug]/pages/[cursor]/route.ts', '@/lib/catalog/preview-reader'],
        ['app/media/[photoId]/[assetRevision]/[profileId]/[variant]/route.ts', '@/lib/catalog/preview-reader'],
        ['lib/media/probe.ts', '../catalog/preview-reader'],
        ['lib/curation/probe.ts', '../catalog/preview-reader'],
        ['lib/site/probe.ts', '../catalog/preview-reader'],
        ['scripts/photos.ts', '../lib/catalog/preview-reader'],
        ['utils/probe.ts', '../lib/catalog/preview-reader'],
        ['proxy.ts', './lib/catalog/preview-reader'],
        ['e2e/probe.spec.ts', '../lib/catalog/preview-reader'],
        ['__tests__/probe.test.ts', '../lib/catalog/preview-reader'],
    ])('rejects %s importing it', async (file, specifier) => {
        const messages = await restrictedImports(file, importing(specifier));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('preview reader');
    });

    it.each([
        ['app/curation/preview/[draftId]/site/page.tsx', '@/lib/catalog/preview-reader'],
        ['app/curation/page.tsx', '@/lib/catalog/preview-reader'],
        ['lib/catalog/probe.ts', './preview-reader'],
        ['lib/catalog/__tests__/probe.test.ts', '../preview-reader'],
    ])('lets %s import it', async (file, specifier) => {
        expect(await restrictedImports(file, importing(specifier))).toEqual([]);
    });

    it.each([
        ['app/curation/preview/[draftId]/site/page.tsx', '@/lib/catalog/public-reader'],
        ['app/curation/preview/[draftId]/site/work/[slug]/page.tsx', '../../../../../../../lib/catalog/public-reader'],
        ['app/curation/preview/preview.ts', '@/lib/catalog/public-reader.ts'],
        ['app/curation/preview/[draftId]/site/media/[photoId]/[assetRevision]/[profileId]/[variant]/route.ts', '@/lib/catalog/public-reader'],
    ])('rejects %s, under the preview, importing the public reader', async (file, specifier) => {
        const messages = await restrictedImports(file, importing(specifier));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('never reads the public catalog');
    });

    it.each(spellings('@/lib/catalog', 'preview-reader'))('rejects %s, which names the preview reader too, outside the allowed folders', async (specifier) => {
        const messages = await restrictedLoads('components/home/Probe.tsx', importing(specifier));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('preview reader');
    });

    it.each(loads('@/lib/catalog/preview-reader'))('rejects a load by %s outside the allowed folders', async (_, source) => {
        for (const file of ['components/home/probe.ts', 'app/api/catalog/series/[slug]/pages/[cursor]/route.ts', '__tests__/probe.test.ts']) {
            const messages = await restrictedLoads(file, source);
            expect(messages, file).toHaveLength(1);
            expect(messages[0], file).toContain('preview reader');
        }
    });

    it.each(loads('@/lib/catalog/preview-reader'))('lets the allowed folders load it by %s', async (_, source) => {
        for (const file of ['app/curation/preview/[draftId]/site/page.tsx', 'lib/catalog/__tests__/probe.test.ts']) expect(await restrictedLoads(file, source), file).toEqual([]);
    });

    it.each(spellings('@/lib/catalog', 'public-reader').map((specifier) => [specifier]).concat(loads('@/lib/catalog/public-reader').map(([, source]) => [source])))('rejects the preview loading the public reader by %s', async (specifierOrSource) => {
        const source = specifierOrSource.includes('\n') ? specifierOrSource : importing(specifierOrSource);
        const messages = await restrictedLoads('app/curation/preview/[draftId]/site/page.tsx', source);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('never reads the public catalog');
    });

    it('leaves a module whose name only starts or ends the same way alone', async () => {
        for (const specifier of ['@/lib/catalog/preview-reader-notes', '@/lib/catalog/my-preview-reader', '@/lib/catalog/reader', '@/lib/catalog/routes', '@/lib/other/preview-readers']) {
            expect(await restrictedLoads('components/home/probe.ts', importing(specifier)), specifier).toEqual([]);
            expect(await restrictedLoads('components/home/probe.ts', `export const probe = () => import('${specifier}');\n`), specifier).toEqual([]);
        }
        expect(await restrictedLoads('app/curation/preview/[draftId]/site/page.tsx', importing('@/lib/catalog/reader'))).toEqual([]);
    });

    it('keeps the rules each folder had: rules.ts stays out of a preview route and of the watcher', async () => {
        expect(await restrictedImports('app/curation/preview/[draftId]/site/page.tsx', "import { runRules } from '@/lib/catalog/rules';\nexport const probe = runRules;\n")).toHaveLength(1);
        expect(await restrictedImports('app/curation/page.tsx', "import { runRules } from '@/lib/catalog/rules';\nexport const probe = runRules;\n")).toHaveLength(1);
        expect(await restrictedImports('utils/probe.ts', "import { insertPhoto } from '../lib/catalog/sequence';\nexport const probe = insertPhoto;\n")).toHaveLength(1);
        expect(await restrictedImports('lib/media/probe.ts', "import { cache } from 'next/server';\nexport const probe = cache;\n")).toHaveLength(1);
    });
});
