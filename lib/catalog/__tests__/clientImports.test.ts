// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

// Every prop and module a 'use client' file takes ships to visitors. The
// reader and the projections import lib/media/url.ts, which pulls in
// node:crypto through lib/identity/ids.ts, so client code takes only types
// from them (#3). Server components may import them freely.

const GUARDED = /^lib\/catalog\/(reader|public-reader|projections\/[^/]+)$/;

/** The repo-relative module `specifier` names from `file`, without its extension, or null for a package. */
function target(file: string, specifier: string): string | null {
    let resolved: string;
    if (specifier.startsWith('@/')) resolved = specifier.slice(2);
    else if (specifier.startsWith('.')) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    else return null;
    return resolved.replace(/\.(ts|tsx)$/, '');
}

/** Whether an import clause brings in only types: `import type ...`, or every named specifier marked `type`. */
function typeOnly(clause: string): boolean {
    const text = clause.trim();
    if (text.startsWith('type ')) return true;
    const named = /^\{([^}]*)\}$/.exec(text);
    if (!named) return false;
    const names = named[1].split(',').map((name) => name.trim()).filter(Boolean);
    return names.length > 0 && names.every((name) => name.startsWith('type '));
}

/** The guarded modules `source`, at repo path `file`, imports or re-exports at runtime, when it's a client module. */
function runtimeCatalogImports(file: string, source: string): string[] {
    if (!/^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source)) return [];
    const found: string[] = [];
    for (const [, keyword, clause, specifier] of source.matchAll(/^\s*(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
        const module = target(file, specifier);
        if (module === null || !GUARDED.test(module)) continue;
        if (keyword === 'import' && typeOnly(clause)) continue;
        if (keyword === 'export' && clause.trim().startsWith('type ')) continue;
        found.push(`${file} imports ${specifier} at runtime`);
    }
    for (const [, specifier] of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
        const module = target(file, specifier);
        if (module !== null && GUARDED.test(module)) found.push(`${file} imports ${specifier} for its side effects`);
    }
    return found;
}

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        const relative = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...sourceFiles(relative));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(relative);
        }
    }
    return out;
}

describe('client modules and the catalog read path', () => {
    it('take only types from the reader and the projections', () => {
        const found = ['app', 'components'].flatMap(sourceFiles).flatMap((file) => runtimeCatalogImports(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
        expect(found).toEqual([]);
    });

    it('covers a client module that takes types from them, as WorkCoverImage does', () => {
        const source = fs.readFileSync(path.join(REPO_ROOT, 'components/work/WorkCoverImage.tsx'), 'utf8');
        expect(source).toMatch(/^'use client';/);
        expect(source).toContain("import type { WorkCover } from '@/lib/catalog/projections/work';");
    });

    it.each([
        ["'use client';\nimport { photoCountLabel } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport { type WorkCover, photoCountLabel } from '../../lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport { createRouteBuilder } from '@/lib/catalog/reader';\n", 1],
        ["'use client';\nexport { publicRoutes } from '@/lib/catalog/public-reader';\n", 1],
        ["'use client';\nimport '@/lib/catalog/projections/work';\n", 1],
        ["// A note first.\n'use client';\nimport { LEGACY_GALLERY_PATH } from '@/lib/catalog/projections/work';\n", 1],
        ["'use client';\nimport type { WorkCover } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nimport { type WorkCover, type WorkCatalog } from '@/lib/catalog/projections/work';\n", 0],
        ["'use client';\nimport { VARIANT_WIDTHS } from '@/lib/identity/variants';\n", 0],
        ["import { photoCountLabel } from '@/lib/catalog/projections/work';\n", 0],
    ] as const)('flags %j %d times', (source, count) => {
        expect(runtimeCatalogImports('components/work/Probe.tsx', source)).toHaveLength(count);
    });
});
