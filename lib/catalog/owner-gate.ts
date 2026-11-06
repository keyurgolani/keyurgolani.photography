import { isInside, realpathLoose } from '../storage/fsx';
import type { CREDENTIAL_COMMANDS } from '../curation/auth/credential-cli';
import type { CURATION_COMMANDS } from '../curation/commands';
import { writerGate, type WriterKind } from './data-root-owner';

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
 * The coverage test sees commands and subcommands, not flags. A flag that
 * makes a reader write, as --yes, --apply, --set-aside or an --out into the
 * data root do, needs its own rule here and its own pin in
 * ownerGatePins.test.ts, and review is what catches one that has neither. A
 * subcommand of identity or curation the table doesn't know is a writer, so
 * it fails closed.
 *
 * Read here means it takes no lock and writes nothing under the data root,
 * as traced over each command's run and its lock calls (round 3b): status,
 * list, validate, diff, history, identity status, curation list and show,
 * describe --import --dry-run, carry-over without --apply, rollback without
 * --yes outside a terminal (it plans before it takes the catalog lock, and
 * stops at CONFIRMATION_REQUIRED), migrate --dry-run --out outside the data
 * root, and the credential commands, which write only their --out file. A
 * lock is a write, a lock file in locks/, so a dry run that takes a lock to
 * read refuses too, as locking-read: purge and purge --revoke without --yes,
 * and gc without --apply or --set-aside. A dry run that writes files is a
 * writer: publish --dry-run writes its candidate and diagnostics, and
 * migrate --dry-run its plan, unless --out puts the plan outside the data
 * root.
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

/**
 * Whether <child> lands inside <parent>, by the realpath of each one's
 * nearest existing folder (round 4), so a symlink into the data root, or a
 * data root that is itself a symlink, can't make a path look outside it.
 */
const inside = (child: string, parent: string) => isInside(realpathLoose(child), realpathLoose(parent));

/** Whether --out, when given, puts what the command writes inside the data root. */
const outInside = (args: readonly string[], root: string | null) => {
    const out = valueOf(args, 'out');
    return out !== undefined && out !== '' && root !== null && inside(out, root);
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
    // They write only their --out file, mode 0400, and never the data root on their own: PHOTOS_ACCESS.curation
    // makes either one a writer when its --out resolves inside the data root (round 4).
    'hash-passphrase': 'read',
    'session-secret': 'read',
};

/** Every top-level `photos` command. */
export const PHOTOS_ACCESS: Record<string, Rule> = {
    migrate: (args, { root }) => {
        if (has(args, 'apply')) return 'identity';
        const out = valueOf(args, 'out');
        // A plan written outside the data root is the owner's file wherever they put it; one inside it, through a symlink too, is the data root's.
        if (out !== undefined && out !== '' && !outInside(args, root)) return 'read';
        return 'migration-plan';
    },
    // Round 4: a subcommand the table doesn't know fails closed, as a writer; its usage error still follows for the owner.
    identity: (args) => (Object.hasOwn(IDENTITY_ACCESS, args[0] ?? '') ? IDENTITY_ACCESS[args[0] as keyof typeof IDENTITY_ACCESS] : 'identity'),
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
    curation: (args, { root }) => {
        const sub = args[0] ?? '';
        if (!Object.hasOwn(CURATION_ACCESS, sub)) return 'curation';
        if ((sub === 'hash-passphrase' || sub === 'session-secret') && outInside(args, root)) return 'credential';
        return CURATION_ACCESS[sub as keyof typeof CURATION_ACCESS];
    },
    // Round 3b: their dry runs take the catalog lock, and purge's and gc's the authored lock too, to read.
    purge: (args) => {
        if (!has(args, 'yes')) return 'locking-read';
        return has(args, 'revoke') ? 'revoke' : 'tombstone';
    },
    gc: (args) => {
        if (has(args, 'set-aside')) return 'set-aside';
        return has(args, 'apply') ? 'gc-apply' : 'locking-read';
    },
};

/** <argv>'s command as the refusal names it, and how it uses the data root, or undefined for a command the dispatcher doesn't know. */
export function commandAccess(argv: readonly string[], ctx: GateContext): { name: string; access: Access } | undefined {
    const [command, ...args] = argv;
    if (command === undefined || !Object.hasOwn(PHOTOS_ACCESS, command)) return undefined;
    const rule = PHOTOS_ACCESS[command];
    const access = typeof rule === 'function' ? rule(args, ctx) : rule;
    const sub = command === 'identity' || command === 'curation' ? ` ${args[0] ?? ''}` : '';
    const flag = access === 'set-aside' ? ' --set-aside' : access === 'gc-apply' ? ' --apply' : access === 'revoke' ? ' --revoke --yes' : access === 'tombstone' ? ' --yes' : access === 'locking-read' && has(args, 'revoke') ? ' --revoke' : '';
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

