import fs from 'node:fs';
import path from 'node:path';
import type { CREDENTIAL_COMMANDS } from '../curation/auth/credential-cli';
import type { CURATION_COMMANDS } from '../curation/commands';
import { ownerRefusal, type WriterKind } from './data-root-owner';

/**
 * The A11 coordinator's round 3 rule, in one table: any command that takes a
 * lock or writes under the data root refuses as a non-owner before its first
 * lock, exit 1, WRONG_OWNER, writing nothing, with what its own files would
 * break. Read-only commands and dry runs still report, as any uid.
 *
 * Every command scripts/photos.ts dispatches is a key of PHOTOS_ACCESS, every
 * `photos identity` subcommand of IDENTITY_ACCESS, and every `photos curation`
 * and credential command of CURATION_ACCESS: ownerGate.test.ts fails for one
 * that isn't. Each answers `read`, or the kind of writer it is, from its
 * arguments, so a flag such as --yes, --apply or --set-aside makes a writer of
 * a dry run. The watcher asks too, at its start, as `watcher`.
 *
 * Read-only here means it takes no lock and writes nothing under the data
 * root: status, list, validate, diff, history and identity status. A dry run
 * that takes its locks only to read is read too: purge and purge --revoke
 * without --yes, gc without --apply or --set-aside, and rollback without
 * --yes and with no terminal to confirm in, which stops before it writes. A
 * dry run that writes files is a writer: publish --dry-run writes its
 * candidate and diagnostics, and migrate --dry-run its plan, unless --out
 * puts the plan outside the data root. The credential commands write only
 * their --out file and never touch the data root.
 */

export type Access = 'read' | WriterKind;

export interface GateContext {
    /** Whether stdin is a terminal, where rollback asks to confirm and then writes. */
    tty: boolean;
    /** The data root the command would use, or null when it has none. */
    root: string | null;
}

type Rule = Access | ((args: readonly string[], ctx: GateContext) => Access);

/** Whether <args> holds --<name>, alone or as --<name>=<value>. */
const has = (args: readonly string[], name: string) => args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));

/** The value of --<name> in <args>, as --<name> <value> or --<name>=<value>. */
function valueOf(args: readonly string[], name: string): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === `--${name}`) return args[i + 1];
        if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
    }
    return undefined;
}

const inside = (child: string, parent: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** `photos identity <subcommand>`. */
export const IDENTITY_ACCESS: Record<'status' | 'bind' | 'new' | 'archive' | 'retry' | 'reprofile', Access> = {
    status: 'read',
    bind: 'identity',
    new: 'identity',
    archive: 'identity',
    retry: 'identity',
    reprofile: 'identity',
};

/** `photos curation <command>`, its credential commands included. */
export const CURATION_ACCESS: Record<(typeof CURATION_COMMANDS)[number] | (typeof CREDENTIAL_COMMANDS)[number], Access> = {
    list: 'read',
    show: 'read',
    edit: 'curation',
    approve: 'curation',
    defer: 'curation',
    dismiss: 'curation',
    retry: 'curation',
    reopen: 'curation',
    confirm: 'curation',
    bind: 'curation',
    archive: 'curation',
    resolve: 'curation',
    'confirm-missing': 'curation',
    // They write only their --out file, mode 0400, wherever it is, and never the data root.
    'hash-passphrase': 'read',
    'session-secret': 'read',
};

/** Every top-level `photos` command. */
export const PHOTOS_ACCESS: Record<string, Rule> = {
    migrate: (args, { root }) => {
        if (has(args, 'apply')) return 'identity';
        const out = valueOf(args, 'out');
        // A plan written outside the data root is the owner's file wherever they put it.
        if (out !== undefined && out !== '' && (root === null || !inside(out, root))) return 'read';
        return 'migration-plan';
    },
    identity: (args) => IDENTITY_ACCESS[args[0] as keyof typeof IDENTITY_ACCESS] ?? 'read',
    status: 'read',
    list: 'read',
    'draft:init': 'authored',
    describe: (args) => (has(args, 'dry-run') ? 'read' : 'authored'),
    'carry-over': (args) => (has(args, 'apply') ? 'authored' : 'read'),
    edit: 'authored',
    sequence: 'authored',
    series: 'authored',
    validate: 'read',
    publish: 'catalog',
    diff: 'read',
    review: 'authored',
    history: 'read',
    rollback: (args, { tty }) => (has(args, 'yes') || tty ? 'catalog' : 'read'),
    verify: 'verify',
    curation: (args) => CURATION_ACCESS[args[0] as keyof typeof CURATION_ACCESS] ?? 'read',
    purge: (args) => {
        if (!has(args, 'yes')) return 'read';
        return has(args, 'revoke') ? 'revoke' : 'tombstone';
    },
    gc: (args) => {
        if (has(args, 'set-aside')) return 'set-aside';
        return has(args, 'apply') ? 'gc-apply' : 'read';
    },
};

/** <argv>'s command as the refusal names it, and how it uses the data root, or undefined for a command the dispatcher doesn't know. */
export function commandAccess(argv: readonly string[], ctx: GateContext): { name: string; access: Access } | undefined {
    const [command, ...args] = argv;
    if (command === undefined || !Object.hasOwn(PHOTOS_ACCESS, command)) return undefined;
    const rule = PHOTOS_ACCESS[command];
    const access = typeof rule === 'function' ? rule(args, ctx) : rule;
    const sub = command === 'identity' || command === 'curation' ? ` ${args[0] ?? ''}` : '';
    const flag = access === 'set-aside' ? ' --set-aside' : access === 'gc-apply' ? ' --apply' : access === 'revoke' ? ' --revoke --yes' : access === 'tombstone' ? ' --yes' : '';
    return { name: `photos ${command}${sub}${flag}`, access };
}

/**
 * The refusal for <argv> as this process's uid, or null: for a reader, a
 * command the dispatcher doesn't know (its usage error says so), a data root
 * that's unset or not there yet (the command says so itself), or a writer
 * run as the data root's owner.
 */
export function ownerGate(argv: readonly string[], ctx: GateContext): string | null {
    const found = commandAccess(argv, ctx);
    if (!found || found.access === 'read') return null;
    return writerGate(ctx.root, found.name, found.access);
}

/** The refusal for writer <name> of <kind> on <root>, or null when there's nothing to protect or its uid owns it. */
export function writerGate(root: string | null, name: string, kind: WriterKind): string | null {
    if (root === null || !fs.existsSync(root)) return null;
    return ownerRefusal(root, name, kind);
}
