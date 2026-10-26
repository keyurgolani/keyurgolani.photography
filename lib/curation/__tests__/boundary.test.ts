// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { isCuratorFile } from '../../../test/helpers/routeInventory';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * No public page, route handler, or the proxy may load a curation module
 * other than 14-2's `lib/curation/auth/`, the boundary itself, or any of the
 * curator's own files, so no public route or API can reveal an inbox item or
 * offer a curator control. The curator's files, under `/curation` and
 * `/api/curation` by URL, are 14-3's inbox, and the route-inventory test
 * (__tests__/routeInventory.test.ts) checks every one of them is guarded.
 */

const AUTH = 'lib/curation/auth/';

function appFiles(): string[] {
    return fs.readdirSync(path.join(REPO_ROOT, 'app'), { recursive: true, encoding: 'utf8' })
        .map((name) => `app/${name.split(path.sep).join('/')}`)
        .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes('__tests__'));
}

/** Every app/ file outside the curator's URLs, plus the proxy and instrumentation, which every request reaches. */
function publicEntries(): string[] {
    return [...appFiles().filter((file) => !isCuratorFile(file)), 'proxy.ts', 'instrumentation.ts'].sort();
}

/** What `entry` loads that only the curator may: a curation module but the auth boundary, or a curator file. */
const curationModules = (entry: string) =>
    importGraph(entry).files.filter((file) => (file.startsWith('lib/curation/') && !file.startsWith(AUTH)) || (file !== entry && isCuratorFile(file)));

describe('the public routes', () => {
    it('include every route handler and page', () => {
        expect(publicEntries()).toEqual(expect.arrayContaining(['app/api/photos/route.ts', 'app/page.tsx', 'app/gallery/page.tsx', 'proxy.ts']));
    });

    it.each(publicEntries())('%s reaches no curation module but the auth boundary', (entry) => {
        expect(curationModules(entry)).toEqual([]);
    });

    it('reach an auth boundary that loads no other curation module', () => {
        for (const entry of ['lib/curation/auth/index.ts', 'lib/curation/auth/policy.ts', 'lib/curation/auth/login.ts']) expect(curationModules(entry)).toEqual([]);
    });

    // By URL, as the route inventory decides it, so a route group or a parallel slot counts too.
    it("leave the curator only its own files, 14-2b's login and 14-3's inbox", () => {
        expect(appFiles().filter(isCuratorFile).sort()).toEqual([
            'app/api/curation/login/route.ts',
            'app/api/curation/logout/route.ts',
            'app/api/curation/media/[photoId]/[assetRevision]/[profileId]/[variant]/route.ts',
            'app/curation/CuratorHeader.tsx',
            'app/curation/inbox/EmptyArrival.tsx',
            'app/curation/inbox/EventBadge.tsx',
            'app/curation/inbox/InboxDetailView.tsx',
            'app/curation/inbox/InboxList.tsx',
            'app/curation/inbox/ItemActions.tsx',
            'app/curation/inbox/LandOnItem.tsx',
            'app/curation/inbox/ReturnToRow.tsx',
            'app/curation/inbox/actions.ts',
            'app/curation/inbox/journey.ts',
            'app/curation/inbox/loading.tsx',
            'app/curation/inbox/page.tsx',
            'app/curation/login/page.tsx',
            'app/curation/page.tsx',
        ]);
    });
});
