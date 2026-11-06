// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_COMMANDS } from '../../curation/auth/credential-cli';
import { CURATION_COMMANDS } from '../../curation/commands';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import { commandAccess, CURATION_ACCESS, IDENTITY_ACCESS, PHOTOS_ACCESS } from '../owner-gate';

/**
 * The A11 coordinator's round 3: one table classifies every command the
 * dispatcher knows. A command added to scripts/photos.ts, to `photos
 * identity`, to `photos curation` or to its credential commands, and not to
 * lib/catalog/owner-gate.ts, fails here.
 */

const PHOTOS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'photos.ts'), 'utf8');

/** The top-level commands main() dispatches on, read from its source. */
function dispatched(source: string): string[] {
    const main = source.slice(source.indexOf('async function main('));
    return [...new Set([...main.matchAll(/command === '([^']+)'/g)].map((match) => match[1]))].sort();
}

/** The identity subcommands: DECISION_COMMANDS, and status. */
function identitySubcommands(source: string): string[] {
    const list = /const DECISION_COMMANDS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    return [...[...list.matchAll(/'([^']+)'/g)].map((match) => match[1]), 'status'].sort();
}

const keys = (table: object) => Object.keys(table).sort();

describe('the owner gate covers every command (A11 round 3)', () => {
    it('classifies every top-level command main() dispatches, and no other', () => {
        expect(dispatched(PHOTOS_SOURCE).length).toBeGreaterThan(15);
        expect(keys(PHOTOS_ACCESS)).toEqual(dispatched(PHOTOS_SOURCE));
    });

    it('fails a command added to the dispatcher but not the table: the positive control', () => {
        const added = PHOTOS_SOURCE.replace("if (command === 'gc')", "if (command === 'brand-new') return 0;\n        if (command === 'gc')");
        expect(dispatched(added)).toContain('brand-new');
        expect(keys(PHOTOS_ACCESS)).not.toEqual(dispatched(added));
    });

    it('classifies every identity subcommand', () => {
        expect(identitySubcommands(PHOTOS_SOURCE)).toEqual(['archive', 'bind', 'new', 'reprofile', 'retry', 'status']);
        expect(keys(IDENTITY_ACCESS)).toEqual(identitySubcommands(PHOTOS_SOURCE));
    });

    it('classifies every curation command and credential command', () => {
        expect(keys(CURATION_ACCESS)).toEqual([...CURATION_COMMANDS, ...CREDENTIAL_COMMANDS].sort());
    });

    it('compares --out by the realpath of its nearest existing folder, so a symlink into the data root makes a writer', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-gate-out-'));
        const root = path.join(base, 'data');
        fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
        const outside = path.join(base, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(root, path.join(outside, 'root-link'));
        const at = (argv: string[]) => commandAccess(argv, { tty: false, root })?.access;
        expect(at(['migrate', '--dry-run', '--out', path.join(outside, 'migration')])).toBe('read');
        expect(at(['migrate', '--dry-run', '--out', path.join(outside, 'root-link', 'identity', 'new')])).toBe('migration-plan');
        expect(at(['curation', 'session-secret', '--out', path.join(outside, 's.key')])).toBe('read');
        expect(at(['curation', 'session-secret', '--out', path.join(outside, 'root-link', 'locks', 'stray.key')])).toBe('credential');
        expect(at(['curation', 'session-secret', '--out', path.join(root, 'locks', 'stray.key')])).toBe('credential');
        // A data root reached through a symlink of its own.
        fs.symlinkSync(root, path.join(base, 'data-link'));
        expect(commandAccess(['curation', 'session-secret', '--out', path.join(root, 'x.key')], { tty: false, root: path.join(base, 'data-link') })?.access).toBe('credential');
    });

    it('answers by flag where a flag makes a writer', () => {
        const ctx = { tty: false, root: '/data/portfolio' };
        const at = (argv: string[], tty = false) => commandAccess(argv, { ...ctx, tty })?.access;
        expect(at(['purge', 'ph_x', '--reason', 'r'])).toBe('locking-read');
        expect(at(['purge', 'ph_x', '--reason', 'r', '--yes'])).toBe('tombstone');
        expect(at(['purge', '--revoke', 'tomb_x', '--reason', 'r', '--yes'])).toBe('revoke');
        expect(at(['gc'])).toBe('locking-read');
        expect(at(['purge', '--revoke', 'tomb_x', '--reason', 'r'])).toBe('locking-read');
        expect(at(['gc', '--apply', 'gc_x'])).toBe('gc-apply');
        expect(at(['gc', '--apply=gc_x'])).toBe('gc-apply');
        expect(at(['gc', '--set-aside', 'assets/p/r'])).toBe('set-aside');
        expect(at(['describe', '--import', 'f.csv', '--dry-run'])).toBe('read');
        expect(at(['describe', '--import', 'f.csv'])).toBe('authored');
        expect(at(['carry-over'])).toBe('read');
        expect(at(['carry-over', '--apply'])).toBe('authored');
        expect(at(['rollback', '--to', '1'])).toBe('read');
        expect(at(['rollback', '--to', '1'], true)).toBe('catalog');
        expect(at(['rollback', '--to', '1', '--yes'])).toBe('catalog');
        expect(at(['publish', '--dry-run'])).toBe('catalog');
        expect(at(['migrate', '--dry-run'])).toBe('migration-plan');
        expect(at(['migrate', '--dry-run', '--out', '/elsewhere/migration'])).toBe('read');
        expect(at(['migrate', '--dry-run', '--out', '/data/portfolio/identity/x'])).toBe('migration-plan');
        expect(at(['migrate', '--apply', '--plan', 'p.json'])).toBe('identity');
        expect(at(['identity', 'status'])).toBe('read');
        expect(at(['identity', 'archive', 'ph_x'])).toBe('identity');
        expect(at(['curation', 'list'])).toBe('read');
        expect(at(['curation', 'defer', 'evt_x'])).toBe('curation');
        expect(at(['curation', 'session-secret', '--out', '/elsewhere/x.key'])).toBe('read');
        expect(at(['curation', 'hash-passphrase', '--out', '/data/portfolio/locks/catalog.lock'])).toBe('credential');
        expect(at(['identity', 'frobnicate'])).toBe('identity');
        expect(at(['identity'])).toBe('identity');
        expect(at(['curation', 'frobnicate'])).toBe('curation');
        expect(at(['curation'])).toBe('curation');
        expect(at(['verify'])).toBe('verify');
        expect(at(['nonsense'])).toBeUndefined();
    });
});
