// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

/**
 * 14-1 is local and CLI only. No page, route handler, or the proxy may load
 * any curation module, so no public route or API can reveal an inbox item or
 * offer a curator control. 14-2 adds the authenticated boundary and its
 * `auth` module, the only one `web` will import.
 */

function publicEntries(): string[] {
    const files = fs.readdirSync(path.join(REPO_ROOT, 'app'), { recursive: true, encoding: 'utf8' })
        .map((name) => `app/${name.split(path.sep).join('/')}`)
        .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes('__tests__'));
    return [...files, 'proxy.ts'].sort();
}

describe('the public routes', () => {
    it('include every route handler and page', () => {
        expect(publicEntries()).toEqual(expect.arrayContaining(['app/api/photos/route.ts', 'app/page.tsx', 'app/gallery/page.tsx', 'proxy.ts']));
    });

    it.each(publicEntries())('%s reaches no curation module', (entry) => {
        expect(importGraph(entry).files.filter((file) => file.startsWith('lib/curation/'))).toEqual([]);
    });

    it('have no curation route', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'app', 'curation'))).toBe(false);
        expect(fs.existsSync(path.join(REPO_ROOT, 'app', 'api', 'curation'))).toBe(false);
    });
});
