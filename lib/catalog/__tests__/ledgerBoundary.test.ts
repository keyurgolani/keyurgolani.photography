// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * A9 (#182): `photos diff` and `photos review` live in ledger-cli.ts, which
 * only the photos CLI and its tests import, so no page, route or server
 * action under app/ may reach it by any path. The screen's "Use the
 * published value" goes through the shared writer, use-published.ts, from
 * its server action only: the view that builds the rows reads the pure
 * rules, never the writer or its locks.
 */

const LEDGER_CLI = /^lib\/catalog\/ledger-cli\.ts$/;
const WRITER = /^lib\/catalog\/use-published\.ts$/;

function modules(dir: string): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
        .filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file) && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
        .sort();
}

const APP_ENTRIES = [...modules('app'), ...modules('components'), 'proxy.ts', 'instrumentation.ts', 'next.config.mjs'];

describe('the ledger command boundary', () => {
    it.each(APP_ENTRIES)('keeps %s from reaching ledger-cli.ts', (entry) => {
        expect(importGraph(entry).files.filter((file) => LEDGER_CLI.test(file))).toEqual([]);
    });

    it('lets the Publish action reach the shared writer, and keeps the view and the client screen off it', () => {
        expect(importGraph('app/curation/publish/actions.ts').files).toContain('lib/catalog/use-published.ts');
        expect(importGraph('scripts/photos.ts').files).toContain('lib/catalog/use-published.ts');
        for (const entry of ['lib/curation/publish-view.ts', 'app/curation/publish/PublishScreen.tsx', 'lib/curation/publish-facts.ts', 'lib/curation/publish-watch.ts']) {
            expect(importGraph(entry).files.filter((file) => WRITER.test(file)), entry).toEqual([]);
        }
        expect(importGraph('lib/curation/publish-view.ts').files).toContain('lib/catalog/use-published-rules.ts');
    });
});
