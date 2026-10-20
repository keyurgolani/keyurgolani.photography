// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
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

const importing = (specifier: string) => `import * as probe from '${specifier}';\nexport { probe };\n`;

/** What the watcher process must never load: the operations, the writer, and the curation modules that use them. */
const FORBIDDEN = /^lib\/catalog\/(?:sequence[^/]*|working-layer-writer)\.ts$|^lib\/curation\/(?:actions|policy|resolutions)\.ts$/;
const forbidden = (files: string[]) => files.filter((file) => FORBIDDEN.test(file));

describe('the ingestion lint rule', { timeout: 60_000 }, () => {
    it.each([
        ['scripts/imageWatcher.ts', importing('../lib/catalog/sequence')],
        ['scripts/imageWatcher.ts', importing('../lib/catalog/working-layer-writer')],
        ['scripts/imageWatcher.ts', importing('@/lib/catalog/sequence-commands')],
        ['scripts/imageWatcher.ts', "export * from '../lib/catalog/sequence';\n"],
        ['utils/probe.ts', importing('../lib/catalog/working-layer-writer')],
        ['utils/nested/probe.ts', importing('../../lib/catalog/sequence')],
        ['lib/identity/probe.ts', importing('../catalog/sequence')],
        ['lib/storage/probe.ts', importing('../catalog/working-layer-writer')],
        ['lib/ingest/missing.ts', importing('../catalog/sequence')],
        ['lib/curation/inbox.ts', importing('../catalog/working-layer-writer')],
    ])('rejects %s importing the operations or the writer: %j', async (file, source) => {
        expect(await restrictedImports(file, source)).toEqual([expect.stringMatching(/Ingestion never authors order/)]);
    });

    it('still keeps Next out of lib/storage and lib/identity', async () => {
        expect(await restrictedImports('lib/storage/probe.ts', importing('next/server'))).toEqual([expect.stringMatching(/outside Next/)]);
        expect(await restrictedImports('lib/identity/probe.ts', importing('server-only'))).toHaveLength(1);
    });

    it.each([
        ['lib/ingest/missing.ts', importing('../catalog/working-layer')],
        ['utils/probe.ts', `${importing('../lib/catalog/order')}import { readWorkingLayer } from '../lib/catalog/working-layer';\nexport { readWorkingLayer };\n`],
        ['lib/curation/__tests__/probe.test.ts', importing('../../catalog/working-layer-writer')],
        ['scripts/photos.ts', importing('../lib/catalog/sequence-commands')],
        ['lib/catalog/sequence.ts', importing('./working-layer-writer')],
        ['lib/catalog/sequence-commands.ts', importing('./sequence')],
        ['lib/curation/actions.ts', importing('../catalog/sequence')],
        ['lib/curation/policy.ts', importing('../catalog/sequence')],
        ['lib/curation/resolutions.ts', importing('../catalog/working-layer-writer')],
    ])('allows %s: %j', async (file, source) => {
        expect(await restrictedImports(file, source)).toEqual([]);
    });
});

describe('the watcher process import graph', () => {
    it.each(['scripts/imageWatcher.ts', 'lib/identity/pass.ts', 'lib/identity/migration.ts'])('from %s reaches neither the operations nor the writer', (entry) => {
        const { files } = importGraph(entry);
        expect(files).toContain(entry);
        expect(forbidden(files)).toEqual([]);
    });

    it('covers the watcher\'s whole pipeline, not only its entry file', () => {
        const { files } = importGraph('scripts/imageWatcher.ts');
        expect(files).toEqual(expect.arrayContaining(['utils/watcherHandlers.ts', 'utils/imageOptimizer.ts', 'lib/storage/config.ts']));
    });

    it('lets a watcher module read the working layer and the catalog reader', () => {
        const { files } = importGraph('lib/ingest/probe.ts', { source: `${importing('../catalog/working-layer')}import { createCatalogReader } from '../catalog/reader';\nexport { createCatalogReader };\n` });
        expect(files).toEqual(expect.arrayContaining(['lib/catalog/working-layer.ts', 'lib/catalog/reader.ts']));
        expect(forbidden(files)).toEqual([]);
    });

    it.each([
        ['a module that imports the operations', importing('../catalog/sequence-commands'), ['lib/catalog/sequence-commands.ts', 'lib/catalog/sequence.ts', 'lib/catalog/working-layer-writer.ts']],
        ['a dynamic import', "export const load = () => import('../catalog/working-layer-writer');\n", ['lib/catalog/working-layer-writer.ts']],
        ['an alias import', importing('@/lib/catalog/sequence'), ['lib/catalog/sequence.ts', 'lib/catalog/working-layer-writer.ts']],
        ['a type-only import', "import type { WriteAuthoredOptions } from '../catalog/working-layer-writer';\nexport type Probe = WriteAuthoredOptions;\n", ['lib/catalog/working-layer-writer.ts']],
    ])('catches %s', (_label, source, expected) => {
        expect(forbidden(importGraph('lib/ingest/probe.ts', { source }).files)).toEqual(expected.sort());
    });
});
