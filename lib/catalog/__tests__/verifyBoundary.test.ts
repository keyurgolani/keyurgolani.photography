// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * #117: only `photos verify` writes `status/verify.json`, so no page,
 * route or server action under app/ may reach verify-cli.ts, which holds the
 * run and the record write, by any import path. The Publish screen reads
 * the record through verify.ts's lastKnownGood(), which writes nothing. The
 * watcher reaches neither, since verify runs on demand only.
 */

const VERIFY_CLI = /^lib\/catalog\/verify-cli\.ts$/;
const VERIFY = /^lib\/catalog\/verify(?:-cli)?\.ts$/;

/** Every module under `dir`, tests left out. */
function modules(dir: string): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
        .filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file) && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
        .sort();
}

const APP_ENTRIES = [...modules('app'), ...modules('components'), 'proxy.ts', 'instrumentation.ts', 'next.config.mjs'];
const WATCHER_ENTRIES = ['scripts/imageWatcher.ts', 'scripts/watcherHealth.ts', 'lib/identity/worker.ts', 'lib/identity/pass.ts'];

describe('the verify command boundary', () => {
    it('covers the Publish screen, its load and its actions', () => {
        expect(APP_ENTRIES).toEqual(expect.arrayContaining(['app/curation/publish/page.tsx', 'app/curation/publish/load.ts', 'app/curation/publish/actions.ts']));
    });

    it.each(APP_ENTRIES)('keeps %s from reaching verify-cli.ts', (entry) => {
        expect(importGraph(entry).files.filter((file) => VERIFY_CLI.test(file))).toEqual([]);
    });

    it.each(WATCHER_ENTRIES)('keeps the watcher entry %s from reaching verify', (entry) => {
        expect(importGraph(entry).files.filter((file) => VERIFY.test(file))).toEqual([]);
    });

    it('sees the Publish page reach verify.ts, and the photos CLI reach both, so the walk would see an import', () => {
        expect(importGraph('app/curation/publish/page.tsx').files).toContain('lib/catalog/verify.ts');
        expect(importGraph('scripts/photos.ts').files.filter((file) => VERIFY.test(file))).toEqual(['lib/catalog/verify-cli.ts', 'lib/catalog/verify.ts']);
    });
});
