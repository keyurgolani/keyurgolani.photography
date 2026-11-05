// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { callSites, shippedFiles } from '../../../test/helpers/deleteCalls';
import { directImports, importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * #15's Keep 12: only the CLI can delete files through GC, so no HTTP route,
 * page, or the watcher may reach the retention module, by any import path.
 * #181's A10: nor purge, which writes tombstones and revokes. `/media` reads
 * tombstones through lib/catalog/tombstones.ts, which writes nothing.
 */

const RETENTION = /^lib\/catalog\/(?:retention|purge)(?:-cli)?\.ts$/;
const reaches = (entry: string) => importGraph(entry).files.filter((file) => RETENTION.test(file));

/** Every module under `dir`, tests left out. */
function modules(dir: string): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
        .filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file) && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
        .sort();
}

/** The web process: its routes and pages, the proxy, the server's register() hook, and the Next config it loads. */
const WEB_ENTRIES = [...modules('app'), ...modules('components'), 'proxy.ts', 'instrumentation.ts', 'next.config.mjs'];
const WATCHER_ENTRIES = ['scripts/imageWatcher.ts', 'lib/identity/worker.ts', 'lib/identity/pass.ts'];

describe('the retention module boundary', () => {
    it('covers every route handler and page', () => {
        expect(WEB_ENTRIES).toEqual(expect.arrayContaining(['app/api/ready/route.ts', 'app/page.tsx', 'proxy.ts', 'instrumentation.ts', 'next.config.mjs']));
        expect(WEB_ENTRIES.some((file) => file.startsWith('app/media/'))).toBe(true);
    });

    it.each(WEB_ENTRIES)('keeps %s from reaching it', (entry) => {
        expect(reaches(entry)).toEqual([]);
    });

    it.each(WATCHER_ENTRIES)('keeps the watcher entry %s from reaching it', (entry) => {
        expect(reaches(entry)).toEqual([]);
    });

    it("follows instrumentation.ts's dynamic import, so a retention import behind it would show", () => {
        expect(importGraph('instrumentation.ts').files).toContain('lib/site/config.ts');
    });

    it('is reached from the photos CLI, so the walk would see it', () => {
        expect(reaches('scripts/photos.ts')).toEqual(['lib/catalog/purge-cli.ts', 'lib/catalog/purge.ts', 'lib/catalog/retention-cli.ts', 'lib/catalog/retention.ts']);
    });

    it("lets /media read tombstones, and reach neither writer through them", () => {
        const route = 'app/media/[photoId]/[assetRevision]/[profileId]/[variant]/route.ts';
        expect(importGraph(route).files).toContain('lib/catalog/tombstones.ts');
        expect(reaches(route)).toEqual([]);
        expect(reaches('lib/catalog/tombstones.ts')).toEqual([]);
        expect(reaches('lib/catalog/asset-rules.ts')).toEqual([]);
    });
});

/**
 * The coordinator's line for #181's A10 (11-05): bytes a tombstone took down
 * go only on the owner's explicit `photos gc --apply <digest>`. Never on a
 * timer, at startup, or as a side effect of another command, and `gc`
 * without `--apply` only lists (retentionTombstones.test.ts). So the only
 * module that imports runGc is the gc command's, the only one that imports
 * that is the photos CLI, and the CLI calls it only for `gc`.
 */
describe('who can reach GC\'s deletes', () => {
    const SOURCES = shippedFiles().filter((file) => !file.endsWith('.sh'));
    const importersOf = (target: string) => SOURCES.filter((file) => file !== target && directImports(file).includes(target));

    it('lets only retention-cli.ts import retention.ts, and only the photos CLI import retention-cli.ts', () => {
        expect(importersOf('lib/catalog/retention.ts')).toEqual(['lib/catalog/retention-cli.ts']);
        expect(importersOf('lib/catalog/retention-cli.ts')).toEqual(['scripts/photos.ts']);
    });

    it('names runGc nowhere else in the source tree', () => {
        const naming = SOURCES.filter((file) => /\brunGc(?:Command)?\b/.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
        expect(naming).toEqual(['lib/catalog/retention-cli.ts', 'lib/catalog/retention.ts', 'scripts/photos.ts']);
    });

    it('calls runGc only from runGcCommand, runGcCommand only from gcCommand, and gcCommand only for the gc command', () => {
        expect(callSites('lib/catalog/retention-cli.ts', 'runGc').map((site) => site.fn)).toEqual(['runGcCommand']);
        expect(callSites('scripts/photos.ts', 'runGcCommand').map((site) => site.fn)).toEqual(['gcCommand']);
        const sites = callSites('scripts/photos.ts', 'gcCommand');
        expect(sites.map((site) => site.fn)).toEqual(['main']);
        let guard: ts.Node | undefined = sites[0].node.parent;
        while (guard && !ts.isIfStatement(guard)) guard = guard.parent;
        expect(guard && ts.isIfStatement(guard) ? guard.expression.getText() : null).toBe("command === 'gc'");
    });

    it.each([
        'lib/catalog/publish.ts',
        'lib/catalog/rollback.ts',
        'lib/catalog/verify.ts',
        'lib/catalog/verify-cli.ts',
        'lib/catalog/history-cli.ts',
        'lib/catalog/purge.ts',
        'lib/catalog/purge-cli.ts',
        'lib/catalog/tombstones.ts',
        'lib/catalog/owner-status.ts',
        'instrumentation.ts',
        'scripts/imageWatcher.ts',
        'scripts/watcherHealth.ts',
        'lib/identity/worker.ts',
    ])('keeps %s, and everything it reaches, from retention.ts', (entry) => {
        expect(importGraph(entry).files).not.toContain('lib/catalog/retention.ts');
    });
});
