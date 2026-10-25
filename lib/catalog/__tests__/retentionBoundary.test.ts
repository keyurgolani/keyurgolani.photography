// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * #15's Keep 12: only the CLI can delete files through GC, so no HTTP route,
 * page, or the watcher may reach the retention module, by any import path.
 */

const RETENTION = /^lib\/catalog\/retention(?:-cli)?\.ts$/;
const reaches = (entry: string) => importGraph(entry).files.filter((file) => RETENTION.test(file));

/** Every module under `dir`, tests left out. */
function modules(dir: string): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
        .filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file) && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
        .sort();
}

const WEB_ENTRIES = [...modules('app'), ...modules('components'), 'proxy.ts'];
const WATCHER_ENTRIES = ['scripts/imageWatcher.ts', 'lib/identity/worker.ts', 'lib/identity/pass.ts'];

describe('the retention module boundary', () => {
    it('covers every route handler and page', () => {
        expect(WEB_ENTRIES).toEqual(expect.arrayContaining(['app/api/photos/route.ts', 'app/api/ready/route.ts', 'app/page.tsx', 'proxy.ts']));
        expect(WEB_ENTRIES.some((file) => file.startsWith('app/media/'))).toBe(true);
    });

    it.each(WEB_ENTRIES)('keeps %s from reaching it', (entry) => {
        expect(reaches(entry)).toEqual([]);
    });

    it.each(WATCHER_ENTRIES)('keeps the watcher entry %s from reaching it', (entry) => {
        expect(reaches(entry)).toEqual([]);
    });

    it('is reached from the photos CLI, so the walk would see it', () => {
        expect(reaches('scripts/photos.ts')).toEqual(['lib/catalog/retention-cli.ts', 'lib/catalog/retention.ts']);
    });
});
