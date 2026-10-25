// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * No page, route handler, or the proxy may load a curation module other than
 * 14-2's `lib/curation/auth/`, the boundary itself, so no public route or API
 * can reveal an inbox item or offer a curator control. The curator's own
 * pages, under app/curation/, hold only 14-2's placeholder until 14-3 builds
 * the inbox there behind requireCurator(), and the route-inventory test
 * (__tests__/routeInventory.test.ts) checks every one of them is guarded.
 */

const AUTH = 'lib/curation/auth/';

function publicEntries(): string[] {
    const files = fs.readdirSync(path.join(REPO_ROOT, 'app'), { recursive: true, encoding: 'utf8' })
        .map((name) => `app/${name.split(path.sep).join('/')}`)
        .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes('__tests__'));
    return [...files, 'proxy.ts', 'instrumentation.ts'].sort();
}

const curationModules = (entry: string) => importGraph(entry).files.filter((file) => file.startsWith('lib/curation/') && !file.startsWith(AUTH));

describe('the public routes', () => {
    it('include every route handler and page', () => {
        expect(publicEntries()).toEqual(expect.arrayContaining(['app/api/photos/route.ts', 'app/page.tsx', 'app/gallery/page.tsx', 'proxy.ts']));
    });

    it.each(publicEntries())('%s reaches no curation module but the auth boundary', (entry) => {
        expect(curationModules(entry)).toEqual([]);
    });

    it('reach an auth boundary that loads no other curation module', () => {
        for (const entry of ['lib/curation/auth/index.ts', 'lib/curation/auth/policy.ts']) expect(curationModules(entry)).toEqual([]);
    });

    it('have no curation route but the placeholder, until 14-3', () => {
        const curator = publicEntries().filter((entry) => entry.startsWith('app/curation/') || entry.startsWith('app/api/curation/'));
        expect(curator).toEqual(['app/curation/page.tsx']);
    });
});
