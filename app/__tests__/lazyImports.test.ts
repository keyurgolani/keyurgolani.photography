// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// #132's review, L3: the error page's nav and the theme menu's popover styles load lazily, off every route's first
// load (perf5's JS budget). Unit tests can't see an eager import come back, since a synchronous component renders as
// well as a lazy one, so this reads the sources: each module named here may reach them only through `import()`.

const root = path.resolve(import.meta.dirname, '..', '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
/** Every module a source imports statically: `import … from '…'`, `import '…'` and `export … from '…'`. */
const staticImports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);
const dynamicImports = (text: string) => [...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);

const LAZY = [
    { file: 'app/error.tsx', lazy: '@/components/site/SiteNav' },
    { file: 'components/ThemeMenu.tsx', lazy: './ThemeMenuPopoverStyles' },
];

describe('the lazy loads off every route', () => {
    for (const { file, lazy } of LAZY) {
        it(`${file} reaches ${lazy} only through import(), and never next/dynamic`, () => {
            const text = source(file);
            expect(staticImports(text)).not.toContain(lazy);
            expect(staticImports(text)).not.toContain('next/dynamic');
            expect(dynamicImports(text)).toContain(lazy);
        });
    }

    it('app/error.tsx keeps the theme menu out too: nothing it imports statically brings SiteNav or ThemeMenu', () => {
        const imports = staticImports(source('app/error.tsx'));
        for (const module of imports) expect(module).not.toMatch(/(?:^|\/)(?:SiteNav|ThemeMenu)$/);
        // The static nav it shows meanwhile has no scripts of its own beyond the route helpers.
        expect(staticImports(source('components/site/StaticSiteNav.tsx')).sort()).toEqual(['./SiteNav.module.css', './nav', './siteRoutesContext']);
    });

    it('reads imports as written', () => {
        expect(staticImports("import a from 'x';\nimport { b } from \"y\";\nimport 'z.css';\nexport { c } from 'w';")).toEqual(['x', 'y', 'z.css', 'w']);
        expect(dynamicImports("lazy(() => import('x'))")).toEqual(['x']);
    });
});
