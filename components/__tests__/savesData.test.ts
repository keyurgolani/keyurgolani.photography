import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savesData } from '../savesData';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('savesData', () => {
    const connection = (value: unknown) => Object.defineProperty(navigator, 'connection', { configurable: true, value });
    afterEach(() => {
        Reflect.deleteProperty(navigator, 'connection');
        vi.unstubAllGlobals();
    });

    it('is true only when the browser says saveData is on', () => {
        connection({ saveData: true });
        expect(savesData()).toBe(true);
    });

    it('is false when saveData is off, missing, not a boolean, or the browser has no connection to ask', () => {
        for (const value of [{ saveData: false }, {}, { saveData: 'true' }, { saveData: 1 }, null, undefined]) {
            connection(value);
            expect(savesData(), JSON.stringify(value) ?? 'undefined').toBe(false);
        }
        Reflect.deleteProperty(navigator, 'connection');
        expect('connection' in navigator).toBe(false);
        expect(savesData()).toBe(false);
    });

    it('is false on the server, where there is no navigator', () => {
        vi.stubGlobal('navigator', undefined);
        expect(savesData()).toBe(false);
    });

    it('reads the browser at each call, so a change after the first one counts', () => {
        connection({ saveData: false });
        expect(savesData()).toBe(false);
        connection({ saveData: true });
        expect(savesData()).toBe(true);
    });
});

/** Every source file under the app's own folders, tests left out. */
function sources(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sources(relative);
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
    });
}

describe('one savesData() for the whole site', () => {
    const files = ['app', 'components', 'lib'].flatMap(sources);

    it('finds the source files it checks', () => {
        expect(files).toContain(path.join('components', 'viewer', 'ViewerShell.tsx'));
        expect(files).toContain(path.join('components', 'IntentPrefetchLink.tsx'));
    });

    it('reads navigator.connection.saveData in components/savesData.ts alone', () => {
        // A read of the property, or its type: `.saveData`, or `saveData?:`. Prose about it in a comment doesn't count.
        const readers = files.filter((file) => /\.saveData\b|\bsaveData\?:/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
        expect(readers).toEqual([path.join('components', 'savesData.ts')]);
    });

    it('is the one the Viewer and the intent prefetch link ask, with no copy of their own', () => {
        for (const file of [path.join('components', 'viewer', 'ViewerShell.tsx'), path.join('components', 'IntentPrefetchLink.tsx')]) {
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            expect(text, file).toMatch(/^import \{ savesData \} from '@\/components\/savesData';$/m);
            expect(text, file).not.toMatch(/function savesData\b|const savesData\b/);
            expect(text, file).toMatch(/\bsavesData\(\)/);
        }
    });
});
