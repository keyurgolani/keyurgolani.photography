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

    it('keeps the rules each folder had: rules.ts stays out of a preview route and of the watcher', async () => {
        expect(await restrictedImports('app/curation/preview/[draftId]/site/page.tsx', "import { runRules } from '@/lib/catalog/rules';\nexport const probe = runRules;\n")).toHaveLength(1);
        expect(await restrictedImports('app/curation/page.tsx', "import { runRules } from '@/lib/catalog/rules';\nexport const probe = runRules;\n")).toHaveLength(1);
        expect(await restrictedImports('utils/probe.ts', "import { insertPhoto } from '../lib/catalog/sequence';\nexport const probe = insertPhoto;\n")).toHaveLength(1);
        expect(await restrictedImports('lib/media/probe.ts', "import { cache } from 'next/server';\nexport const probe = cache;\n")).toHaveLength(1);
    });
});
