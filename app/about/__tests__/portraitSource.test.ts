// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';

// The owner, 2026-10-25: the About photo is configured from the directory
// the site is deployed in, not committed, so swapping the file there is all
// a new portrait takes. These pin that nothing builds it into the image.

const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const lines = (file: string) => read(file).split('\n').map((line) => line.trim());

describe("About's portrait source", () => {
    it('is no module About imports: no image file, nothing under public/, and no static portrait module', () => {
        const { files } = importGraph('app/about/page.tsx');
        expect(files).toContain('lib/siteConfig/aboutPortrait.ts');
        expect(files.filter((file) => /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(file) || file.startsWith('public/'))).toEqual([]);
        expect(fs.existsSync(path.join(REPO_ROOT, 'data/artistPortraitImage.ts'))).toBe(false);
    });

    it('is the same for the portrait route', () => {
        const { files } = importGraph('app/about/portrait/[token]/[variant]/route.ts');
        expect(files.filter((file) => /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(file) || file.startsWith('public/'))).toEqual([]);
    });

    it('stays out of the repository, the image build context, and the standalone trace', () => {
        expect(lines('.gitignore')).toContain('/site-config/');
        expect(lines('.dockerignore')).toContain('site-config');
        expect(read('next.config.mjs')).toContain("'./site-config/**/*'");
        expect(read('ci/check-standalone.sh')).toMatch(/for entry in [^;]*\bsite-config\b/);
    });

    it('is read per request: About and its portrait route are force-dynamic, so a build never freezes the file it saw', () => {
        for (const file of ['app/about/page.tsx', 'app/about/portrait/[token]/[variant]/route.ts']) {
            expect(read(file), file).toMatch(/^export const dynamic = 'force-dynamic';$/m);
        }
    });

    it("is what Home's intro and badge show too: the Home page reads it per request, and nothing it reaches imports an image or public/", () => {
        const { files } = importGraph('app/page.tsx');
        expect(files).toEqual(expect.arrayContaining(['lib/siteConfig/portraitVariants.ts', 'components/HeroReveal.tsx', 'components/ProfilePicture.tsx']));
        expect(files.filter((file) => /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(file) || file.startsWith('public/'))).toEqual([]);
        expect(read('app/page.tsx')).toMatch(/^export const dynamic = 'force-dynamic';$/m);
        expect(fs.existsSync(path.join(REPO_ROOT, 'public/assets/profile'))).toBe(false);
    });
});
