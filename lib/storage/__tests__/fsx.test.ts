// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutAbsolutePaths } from '../fsx';

describe('withoutAbsolutePaths', () => {
    const roots = ['/srv/data', '/srv/data/library'];
    const temps: string[] = [];

    afterEach(() => {
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ["open '/srv/data/library/a.jpg'", "open 'a.jpg'"],
        ["rename '/srv/data/staging/1' -> '/srv/data/assets/2'", "rename 'staging/1' -> 'assets/2'"],
        ["open '/srv/data/library/Keyur's photo.jpg'", "open 'Keyur's photo.jpg'"],
        ['json {"path":"/home/kg/secret/a.jpg"}', 'json {"path":"a.jpg"}'],
        ['in (/opt/app/x.js:10:5)', 'in (x.js:10:5)'],
        ["mkdir '/Volumes/My Drive/data/x'", "mkdir 'x'"],
        ["open 'file:///home/kg/other/a.jpg'", "open 'a.jpg'"],
        ['open file:///home/kg/other/a.jpg', 'open a.jpg'],
        ["open 'file:///srv/data/library/sub/a.jpg'", "open 'sub/a.jpg'"],
        ["copy '/backup/srv/data/x'", "copy 'x'"],
        ['copy /backup/srv/data/x', 'copy x'],
        ['stat /srv/database/x', 'stat x'],
        ['open x:/srv/data/library/a.jpg', 'open x:a.jpg'],
        ['file:/srv/data/library/a.jpg', 'file:a.jpg'],
        ['-/srv/data/library/a.jpg', '-a.jpg'],
        ['see https://example.com/srv/data/x', 'see https://example.com/srv/data/x'],
    ])('rewrites %s', (text, expected) => {
        expect(withoutAbsolutePaths(text, roots)).toBe(expected);
    });

    it.each([
        'see https://example.com/a/b',
        'image/webp',
        '3/4',
        'and/or',
        'w/ x',
        '1 / 2',
        'source-superseded',
        '~/photos/a.jpg',
    ])('leaves %s alone', (text) => {
        expect(withoutAbsolutePaths(text, roots)).toBe(text);
    });

    it('makes a path under a root with a space relative to it, quoted or not', () => {
        const spaced = ['/Volumes/My Drive/lib'];
        expect(withoutAbsolutePaths('stat /Volumes/My Drive/lib/a b.jpg failed', spaced)).toBe('stat a b.jpg failed');
        expect(withoutAbsolutePaths("open '/Volumes/My Drive/lib/sub/a b.jpg'", spaced)).toBe("open 'sub/a b.jpg'");
    });

    it('matches a root holding regular expression characters as its text', () => {
        const odd = ['/Volumes/Photos (2024) [raw]+'];
        expect(withoutAbsolutePaths("open '/Volumes/Photos (2024) [raw]+/sub/a.jpg'", odd)).toBe("open 'sub/a.jpg'");
        expect(withoutAbsolutePaths('stat /Volumes/Photos (2024) [raw]+/a b.jpg failed', odd)).toBe('stat a b.jpg failed');
    });

    it('keeps a quoted file URL outside the roots whole up to its base name, spaces and all', () => {
        expect(withoutAbsolutePaths("open 'file:///Volumes/My Drive/other/a b.jpg'", roots)).toBe("open 'a b.jpg'");
    });

    it('makes a path under a root relative to it when the error spells the root resolved, through a symlink', () => {
        const real = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-real-'));
        const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-link-'));
        temps.push(real, holder);
        const link = path.join(holder, 'library');
        fs.symlinkSync(real, link);
        const resolved = fs.realpathSync.native(real);
        expect(resolved).not.toBe(link);

        expect(withoutAbsolutePaths(`open '${path.join(resolved, 'sub', 'a.jpg')}'`, [link])).toBe("open 'sub/a.jpg'");
        expect(withoutAbsolutePaths(`open '${path.join(link, 'sub', 'a.jpg')}'`, [link])).toBe("open 'sub/a.jpg'");
    });
});
