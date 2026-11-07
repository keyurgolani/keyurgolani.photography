#!/usr/bin/env node
/**
 * Photo identity commands.
 *
 *   npx tsx scripts/photos.ts migrate --dry-run [--out <dir>]
 *     Propose a photo ID for every source without writing identity state.
 *     Writes plan-<ts>.json and report-<ts>.md to identity/migration/ in the
 *     data root, or to --out, which is required when the data root is unset,
 *     unavailable, or unwritable. Prints both paths.
 *
 *   npx tsx scripts/photos.ts migrate --apply --plan <file>
 *     Commit a dry run's plan: write the registry with exactly its photo IDs,
 *     data-root.json if there is none, and applied-<ts>.json mapping each
 *     source path and legacy URL to its photo. Refuses if the library or the
 *     registry changed since the dry run, or if it runs in a container whose
 *     data root is not a mounted volume. Builds no derivatives. Exits 0 when
 *     applied or already applied, 1 when refused, and 2 on a usage error.
 *
 *   npx tsx scripts/photos.ts identity status [--json]
 *     Counts by source health, holds, failed profiles, pending jobs, the data
 *     root's state, and the watcher's heartbeat age. Exits 1 unless the data
 *     root is ready.
 *
 *   npx tsx scripts/photos.ts identity bind <path> <photoId> [--merge <photoId>] [--reason <text>]
 *   npx tsx scripts/photos.ts identity new <path> [--reason <text>]
 *   npx tsx scripts/photos.ts identity archive <photoId> [--reason <text>]
 *   npx tsx scripts/photos.ts identity retry <photoId> [<assetRevision>] [--reason <text>]
 *   npx tsx scripts/photos.ts identity reprofile (<photoId> | --all) [--reason <text>]
 *     Write an identity decision to identity/decisions/ and run a pass that
 *     applies it. If the registry is busy, the decision stays saved and the
 *     watcher applies it on its next pass. Exits 0 when applied or saved, 1
 *     when refused, when the data root isn't ready, or when the pass fails
 *     after the decision is saved, and 2 on a usage error.
 *     <path> is relative to the library, or an absolute path inside it. A
 *     bind to a path another photo holds merges that photo into <photoId>
 *     only when --merge names it, and only if it was minted at that path.
 *
 *   npx tsx scripts/photos.ts status [--json] [--check]
 *     The data root, the catalog mode and active revision, the last publish,
 *     registry counts, the working layer's records, how many photos no series
 *     lists and how many have no reviewed description, the curation inbox's
 *     counts (what needs review, and the open missing, failed, ambiguous and
 *     stale items, each listed, a missing one with its age), and the
 *     watcher's heartbeat. Exits 1 unless the data root is ready and
 *     everything reads. --check is for a monitor: it also exits 1 on an open
 *     missing, failed or ambiguous item, an inbox item it can't read, a
 *     failed last watcher pass, a watcher that has got no pass through for
 *     over 30 minutes, or a heartbeat over 5 minutes old, and prints why;
 *     --json then adds a `check` object with a code for each, and stays JSON
 *     if status itself fails.
 *
 *   npx tsx scripts/photos.ts list [--unassigned] [--json]
 *     Every photo the registry holds, but not archived ones, with its library
 *     path, capture date, series, description state, and the data-root path
 *     of the 400 px WebP it would publish on. --unassigned keeps the photos in
 *     the library that no series lists.
 *
 *   npx tsx scripts/photos.ts draft:init
 *     Create site.json and a photo record for every photo without one, with
 *     no description and the asset revision its source is bound to. Never
 *     overwrites a record.
 *
 *   npx tsx scripts/photos.ts describe --import <file> [--dry-run]
 *     Set descriptions, decorative flags, titles, and captions from a CSV or
 *     JSON file with the columns photoId, alt, decorative, title, and caption.
 *     An empty cell changes nothing, imported descriptions count as reviewed,
 *     and any row it can't apply, such as an unknown photo ID, stops the whole
 *     import before it writes anything. The file is a regular file of at most
 *     5 MiB in UTF-8, and describe-import.ts lists the characters and field
 *     lengths it refuses. --dry-run takes no lock and writes nothing.
 *
 *   npx tsx scripts/photos.ts carry-over [--apply --actor <name>] [--allow-missing <photoId or path>,...]
 *     One-time setup before the launch publish, only on a library the
 *     legacy site served; a fresh library skips it. It puts every photo the
 *     legacy Gallery lists into one published series, Gallery, in its
 *     order, featured and alone in Work's order. The photos
 *     keep the names the Gallery gives them, "Photograph N of T", with no
 *     description, and their records say they were carried over. Without
 *     --apply it writes nothing and prints the plan. It refuses a working
 *     layer with series, a Work order, or a featured series of the owner's,
 *     and exits 1 while a photo the legacy site has can't carry over, unless
 *     --allow-missing names it. Running it again changes nothing. Exits 3
 *     when a lock stays busy, and 4 for I/O.
 *
 *   npx tsx scripts/photos.ts edit (<photoId> | <seriesId> | site) [--file <path>] [--expect-version <N>]
 *     Open a record's newest version in $VISUAL or $EDITOR, check it, and
 *     commit it as the next version. A series without a record opens as a
 *     draft to fill in. --file commits a file instead of opening an editor,
 *     and needs --expect-version, the version the edit started from, when
 *     the record exists. An edit it can't commit stays in edits/ in the data
 *     root, with the command that commits it. Exits 0 when saved or
 *     unchanged, 1 when the edit or the record can't be used, 2 on a usage
 *     error, 3 when the record isn't at the version the edit started from or
 *     the authored lock stays busy, and 4 for I/O. The curator's Series
 *     screen makes a series and edits its title, statements and visibility
 *     the same way (docs/curator.md).
 *
 *   npx tsx scripts/photos.ts sequence <command> <seriesId> ...
 *   npx tsx scripts/photos.ts series order <seriesId>...
 *   npx tsx scripts/photos.ts series featured (<seriesId>... | --clear)
 *     Change a series' photos, cover, opening photo, and chapters, or the
 *     Work order and featured series, through #8's operations. The usage
 *     below lists each form. sequence set and series order need at least one
 *     ID. Exits 0 on success, 1 when the operation is refused, 2 on a usage
 *     error, 3 on a version conflict or a busy authored lock, and 4 for I/O.
 *     The curator's Series screen inserts, moves and removes photos, sets the
 *     cover and opening photo, adds, moves and removes chapters, and sets the
 *     Work order and featured series through the same operations
 *     (docs/curator.md).
 *
 *   npx tsx scripts/photos.ts validate [--reprofile]
 *     Compile the working layer and run every rule, taking no lock and
 *     writing nothing, so it runs on a read-only data root too. Prints the
 *     candidate ID and the first 200 issues. Exits 0 when only warnings
 *     remain, 1 on any error, 2 on a usage error, 4 when a catalog file is
 *     damaged or can't be read, and 3 when the data root isn't ready. Then
 *     prints each screen's read-model size for the candidate beside its
 *     budget in lib/perf/budgets.ts, and a BUDGET_WARNING line for each model
 *     over one (#6). A warning, not a rule: it never changes the exit code.
 *
 *   npx tsx scripts/photos.ts publish [--actor <name>] [--reason <text>] [--expect <candidateId>]
 *                                     [--dry-run] [--confirm-launch] [--reprofile]
 *     Compile the working layer, validate it under the catalog lock, write
 *     its revision, and make that revision active. The actor is --actor or
 *     PHOTOS_ACTOR, and one is required. --reason defaults to publish.
 *     --expect stops unless the candidate has that ID, and --dry-run stops
 *     after validation. The first publish is the launch, so it needs
 *     --confirm-launch, and prints how many photographs it puts on the site:
 *     a one-time setup step for a new data root, never a routine publish.
 *     --reprofile moves every photograph the watcher can rebuild to the
 *     current profile: run identity reprofile --all first. Exits 0 when
 *     published, unchanged, or a dry run passes, 1 on validation errors, 2
 *     on a usage error, 4 when a catalog file is damaged or an I/O error
 *     stops it, and 3 on any other stop. Logs one JSON line per event.
 *
 *   npx tsx scripts/photos.ts diff [--json]
 *     What a publish of the working layer would change for visitors: #16's
 *     ledger against the active revision, grouped as the Publish screen
 *     groups it, with the candidate ID, the live revision, each row's change
 *     ID and review state, an authored or route row's value before and
 *     after (text cut at 200 characters), and what a row that waits on a
 *     review needs. --json prints the same rows in a versioned shape,
 *     schemaVersion 1, with whether photos review can mark each one
 *     (README, "Reviewing what a publish changes"). Takes no lock and
 *     writes nothing. Exits 0,
 *     3 when the data root isn't ready, and 4 when a catalog file is damaged
 *     or can't be read.
 *
 *   npx tsx scripts/photos.ts review <changeId>... --expect <candidateId> --expect-active <revisionId | none> [--actor <name>]
 *     Mark rows photos diff printed reviewed, through the Publish screen's
 *     own writer, after checking them against what is live. --expect and
 *     --expect-active are the candidate and the live revision photos diff
 *     printed, and it writes nothing once either moved. It stamps each field
 *     a row waits on with the value it holds, under the authored lock, and
 *     refuses a value or record that moved. It never clears a suggested
 *     description (write one with photos edit), a row whose Inbox item needs
 *     a decision again, or a rebase conflict, and it names every row: there
 *     is no --all, and rows that share a stamp, such as two moves in one
 *     series, are marked only with all of them named. It checks every
 *     record under one hold on the authored lock before it writes any. The
 *     actor is --actor or PHOTOS_ACTOR, and one is required. Publishes
 *     nothing. Exits 0 when marked or nothing was left
 *     to mark, 1 when a row can't be marked here, so nothing was written, 2
 *     on a usage error, 3 when the draft, the live revision or a record
 *     moved, or the authored lock stays busy, and 4 for I/O.
 *
 *   npx tsx scripts/photos.ts review --use-published <changeId> --expect <candidateId> --expect-active <revisionId | none> [--actor <name>]
 *     Put back what is live for one row instead: the live revision's value
 *     of the row's field goes into the draft as an authored write, through
 *     the writer the Publish screen's "Use the published value" calls. Only
 *     for a field whose review went stale because the live revision changed
 *     it, or that a restore left in conflict, and never while its Inbox item
 *     needs a decision. photos diff names the rows it takes. The draft
 *     changes, so run photos diff again before publishing. Same exit codes.
 *
 *   npx tsx scripts/photos.ts history [--json] [--limit <n>] [--revisions]
 *     Every activation, oldest first by sequence, with its revision number
 *     and ID, actor, reason, time, validation result, and what its revision
 *     changed against its parent. The live one says LIVE, and one that never
 *     moved the active pointer says interrupted. --limit shows the newest n.
 *     --revisions adds each revision that has been live, newest first, with
 *     its rollback eligibility and reasons, planned as rollback plans it.
 *     --json prints it all as one versioned object, its usage and data-root
 *     stops included, with the exit code. Takes no lock and writes
 *     nothing. Exits 0, 2 on a usage error, 3 when the data root isn't
 *     ready, and 4 when a catalog file is damaged: with --limit, only a
 *     shown row's counts, and with --revisions, so does a revision that
 *     can't be planned.
 *
 *   npx tsx scripts/photos.ts rollback --to <number | revisionId> --reason <text> [--actor <name>]
 *                                      [--accept <ruleId>]... [--expect-active <revisionId>] [--yes]
 *     Make a revision that was active before live again, as a new rollback
 *     activation that keeps its number. Prints what it brings back, removes,
 *     and changes against the active revision, and the target's issues: an
 *     integrity error, such as a missing derivative or a privacy rule's,
 *     stops it. An editorial error, such as an accent today's rules refuse,
 *     comes back only with --accept <ruleId> for each flagged rule, given
 *     once per rule; without one it stops before it asks, and the
 *     activation records the rules it accepted. A target whose last
 *     photos verify failed, as status/verify.json records it, or any target
 *     while that record can't be read, stops the same way until
 *     --accept verify.failed, which only this command takes. Then it asks to
 *     confirm in a terminal; elsewhere --yes confirms, and only with
 *     --expect-active naming the active revision the list was made
 *     against. The actor is --actor or PHOTOS_ACTOR, and one is required.
 *     It waits up to 30 s for another command's catalog lock and names the
 *     holder if it can't get it. A target that is already active needs no
 *     confirmation: it finishes what a crashed activation left undone. A
 *     live revision that can't be read is no reason to refuse: the list is
 *     then everything the target publishes. Exits 0 when rolled back or already
 *     active, 1 when the target was never active, its rules stop it, an
 *     editorial error isn't accepted, or its recorded verify failed without
 *     --accept verify.failed, 2 on a usage error (an --accept that isn't an
 *     editorial rule's ID or verify.failed included), 4 when a catalog file is damaged or an I/O error stops
 *     it, and 3 on any other stop, such as no confirmation, another
 *     revision going live first, or a busy lock. Logs one JSON line per
 *     event.
 *
 *   npx tsx scripts/photos.ts verify [--revision <revisionId>] [--json]
 *     Check the catalog the way a restore needs it: every revision file
 *     parses and hashes to its name, every rule passes on it (an integrity
 *     error fails it, an editorial one warns), and every derivative set it
 *     publishes has its manifest's files at their sizes and SHA-256, each set
 *     hashed once. Then the chain: the active pointer names an activation
 *     record for its revision, every previous activation it names exists,
 *     and committed activations have a pointer. Prints each revision's
 *     result and whether a rollback can return to it, and the fix for what
 *     fails. Reads the data root only, never the library, and takes no
 *     catalog lock: only a short lock of its own around writing the record.
 *     A full run records its result in status/verify.json, which the
 *     curator's Publish screen and photos rollback read; --revision checks
 *     one revision alone and records only a pass that started after the
 *     recorded run finished, which clears that revision's recorded failure. Exits 0 when the live revision and the chain pass,
 *     even if an older revision fails, 1 when either fails, 2 on a usage
 *     error, 3 when the data root isn't ready, and 4 when the registry or an
 *     activation record can't be read or an I/O error stops it.
 *
 *   npx tsx scripts/photos.ts curation list [--status <status> | --all] [--json]
 *   npx tsx scripts/photos.ts curation show <eventId> [--json]
 *   npx tsx scripts/photos.ts curation (edit | approve) <eventId> --version <n> [--series <id> | --unassigned]
 *                                      [--start | --end | --after <photoId>] [--description <text> | --decorative]
 *   npx tsx scripts/photos.ts curation (defer | retry | reopen) <eventId> --version <n> [--reason <text>]
 *   npx tsx scripts/photos.ts curation dismiss <eventId> --version <n> --reason <text>
 *   npx tsx scripts/photos.ts curation confirm <eventId> --version <n>
 *     #17's Confirm new asset revision, for a replacement whose new set is
 *     ready (lib/curation/resolutions.ts). Needs --base once a revision is active.
 *     defer leaves a replacement in draft, and on a reopened confirmed one
 *     puts back the revision the confirm replaced, while that confirm is
 *     still the inbox's latest change to the photo's revision. reopen and
 *     show say what defer will do.
 *   npx tsx scripts/photos.ts curation bind <eventId> --version <n> [--path <library path> | --to <photoId>]
 *   npx tsx scripts/photos.ts curation archive <eventId> --version <n>
 *   npx tsx scripts/photos.ts curation confirm-missing <eventId> --version <n>
 *     #17's settlements of a missing source: bind an intentional replacement
 *     (#10's bind decision), or archive after removing series references,
 *     which is the takedown once photos publish runs. archive needs --base
 *     once a revision is active. publish --dry-run lists what would leave
 *     the site under Removed. confirm-missing records that the file is gone
 *     on purpose, and writes the item only.
 *   npx tsx scripts/photos.ts curation resolve <eventId> --version <n> --as new | --as replacement-of <photoId>
 *     #14's answer to an ambiguous item, as #10's new or bind decision, and
 *     bind --to names which of the photographs it may be the file is. On a
 *     replacement, --as new makes the file its own photograph.
 *     The curation inbox (lib/curation/commands.ts). New photographs wait
 *     here until approved into the draft; nothing here publishes. Item
 *     commands take the --version that list or show printed, and --base
 *     <revisionId|none> for the active revision they were reviewed against,
 *     which approve requires once a revision is active, and write nothing
 *     when either moved. An approval keeps a photograph already in the
 *     series where it is unless a position flag or a saved edit picks one.
 *     Exits 0 when done, 1 when
 *     refused, 2 on a usage error, 3 when stale, locked, or the data root
 *     isn't ready, and 4 when a file can't be read. Prints no absolute path.
 *   npx tsx scripts/photos.ts curation hash-passphrase --out <file>
 *   npx tsx scripts/photos.ts curation session-secret --out <file>
 *     The curator's credential, made at deploy time (docs/curator.md):
 *     the scrypt hash of a passphrase read from stdin without echo, and 32
 *     random bytes that sign the session cookie. Each writes one file, mode
 *     0400, and prints no secret. Exits 0 when written, 1 when refused or
 *     the file can't be written, and 2 on a usage error.
 *
 *   npx tsx scripts/photos.ts purge <photoId> [--asset-revision <assetRevision>] --reason <text> [--actor <name>] [--yes]
 *   npx tsx scripts/photos.ts purge --revoke <tombstoneId> --reason <text> [--actor <name>] [--yes]
 *     #15's takedown that survives a rollback. A dry run unless --yes: it
 *     prints one plain line saying what it takes down, then each asset
 *     revision and set, and each revision that was live before and loses
 *     rollback eligibility, and writes nothing. With --yes it prints the same,
 *     then writes catalog/tombstones/<tombstoneId>.json: from the next request
 *     /media answers 410 for every set it lists, and no revision that shows
 *     one can be published or rolled back to. It deletes nothing; only the
 *     owner's photos gc --apply, more than 7 days later, deletes the bytes.
 *     Without --asset-revision it takes down every asset revision the registry
 *     holds for the photo now. It refuses an asset the live revision shows, or
 *     a photo a draft series lists at a targeted asset revision: publish
 *     without it, or take it out with photos sequence remove, first. --revoke
 *     takes a tombstone back until photos gc --apply deletes a folder it
 *     lists; after that the takedown is permanent, and only a backup of the
 *     data root brings it back. The actor is --actor or PHOTOS_ACTOR, and one
 *     is required, as is --reason. Holds the catalog lock, and purge the
 *     authored lock too, waiting up to 30 s for each. Never touches the
 *     library. Exits 0 when planned, written, or already done, 1 when refused
 *     (a live or listed asset, an unknown photo, asset revision or tombstone,
 *     or a revoke after GC deleted or cut short a folder its marker records,
 *     or while one is set aside whole, to rename back first), 2 on a usage
 *     error, 3 when a lock stays busy or the data root isn't ready, and 4 when
 *     a file is damaged or an I/O error stops it.
 *
 *   npx tsx scripts/photos.ts gc [--apply <planDigest>]
 *     Plan the cleanup docs/data-root.md's retention rules allow: staging
 *     folders a killed derivative build left and candidates that never became
 *     a revision, once each is more than 7 days old, and the asset folders a
 *     standing tombstone took down more than 7 days ago that nothing always
 *     protected names (the live revision, a draft series listing the photo at
 *     that asset revision, an open Inbox item, or a staging folder) and whose
 *     manifests account for every file in it. It lists every path with its
 *     class, the rule that allows it, and its size, reports the sets nothing
 *     references without deleting them, prints byte totals and what each
 *     protection keeps, and prints the plan's digest. It deletes nothing
 *     without --apply, which takes that digest, plans again, and deletes only
 *     if the plan is still the same, after one plain line saying what it
 *     deletes. Both hold the catalog and authored locks for the whole run,
 *     waiting up to 30 s for each. Apply sets each tombstoned folder aside as
 *     .gc-<assetRevision>-<prefix>-<uuid>, checks it once more, and only then
 *     deletes it; a .gc- folder a stopped run left is reported, never deleted.
 *     It never deletes any other asset, a revision, an activation, a record, a
 *     tombstone, anything in edits/, or anything in the library. Exits 0 when
 *     planned or applied, 1 when a folder it would delete in is a symlink,
 *     isn't a folder, resolves somewhere else, sits in the library, or changes
 *     just before a delete, 2 on a usage error, 4 when a catalog file is
 *     damaged, an I/O error stops it, a delete fails partway, or a planned
 *     asset folder is always protected now, and 3 on any other stop, such as a
 *     changed plan or a busy lock. --apply logs one JSON line per path it
 *     deletes.
 *
 *   npx tsx scripts/photos.ts gc --set-aside <assets/<photoId>/<assetRevision or .gc-…>>
 *     Renames a folder a standing tombstone takes down, or the .gc- folder a
 *     stopped run left beside one, into the data root's own
 *     trash/<photoId>-<name>-<date-time>/, on the same filesystem, under the
 *     asset's own lock, taken first without waiting, then the catalog,
 *     curation and authored locks, and deletes nothing. It refuses, exit 1, any
 *     other path (NOT_AN_ASSET_PATH), a folder no standing tombstone takes
 *     down (NOT_TAKEN_DOWN), one the live revision, a draft series, an open
 *     Inbox item or a staging folder names (PROTECTED), a .gc- folder set
 *     aside whole, which goes back instead (SET_ASIDE_WHOLE), a symlink, a
 *     file or a symlinked trash/ (UNSAFE_PATH), a cross-device move
 *     (CROSS_DEVICE) and an existing destination (EXISTS); 3 when a lock stays
 *     busy (ASSET_LOCKED at once; CATALOG_LOCKED, CURATION_LOCKED, AUTHORED_LOCKED) or
 *     is lost or the data root isn't ready, and 4 when a file is damaged or an
 *     I/O error stops it. After the rename it asks the always-protected set
 *     again, and puts the folder back (PROTECTED) if anything names it now;
 *     when something took its place, it exits 4 (PUT_BACK_BLOCKED), leaves it
 *     in trash/, and photos status names it with its holder. Emptying trash/
 *     is the owner's own step.
 *
 *   npx tsx scripts/photos.ts legacy-derivatives [--stdout]
 *     Judge the legacy folders a watcher before v1.7.0 wrote at the top of
 *     the library, for scripts/host/legacy-move-aside.sh. For each of the
 *     eight names the library's root lists exactly, case-sensitively, it
 *     records every file with its size and mtime when each is one the v1.x
 *     pipeline wrote for an original the scan sees at the root, by name,
 *     header and width, and otherwise why the folder stays. It only reads
 *     the library, and writes only status/legacy-derivatives.json in the
 *     data root, mode 0644, refusing a symlinked status/. --stdout also
 *     prints the manifest, and the summary goes to stderr, so the owner can
 *     save a copy he can read. The script takes it for 24 hours and one
 *     --apply. Exits 0 when written, 1 when the library or the data root
 *     isn't there or ready, and 2 on a usage error.
 *
 * The library is PHOTOGRAPHY_LIBRARY_DIR, with no default: a command that
 * reads the library exits 1 when it's unset. The data root is
 * PHOTOGRAPHY_DATA_DIR, or portfolio-data under the working directory outside
 * production.
 *
 * The image has no tsx, so it runs the bundle `npm run build:scripts` writes,
 * with the same arguments: node dist/scripts/photos.mjs <command>. In
 * production, run it in the watcher's container, which mounts the library
 * read-only at /data/library and the data root read-write:
 * docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>.
 * The README's "Curating the catalog" section walks through the commands.
 *
 * Every command refuses a flag given twice. The owner commands, status to
 * series, exit 1 when PHOTOGRAPHY_DATA_DIR is unset, and status still prints
 * its report then.
 */

import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runCarryOver } from '../lib/catalog/carry-over';
import { runDescribeImport } from '../lib/catalog/describe-import';
import { runDraftInit } from '../lib/catalog/draft-init';
import { recordRef, runEditRecord } from '../lib/catalog/edit-record';
import { historyArgs, historyStop, rollbackArgs, runHistoryCommand, runRollbackCommand, type HistoryArgs } from '../lib/catalog/history-cli';
import { diffArgs, reviewArgs, runDiffCommand, runReviewCommand } from '../lib/catalog/ledger-cli';
import { purgeArgs, runPurgeCommand } from '../lib/catalog/purge-cli';
import { gcArgs, runGcCommand } from '../lib/catalog/retention-cli';
import { runVerifyCommand, verifyArgs } from '../lib/catalog/verify-cli';
import { runListCommand, runStatusCommand } from '../lib/catalog/owner-status';
import { issueLines, photoIdArg, publishReport, sequenceArgs, seriesArgs, parseFlags, UsageError } from '../lib/catalog/owner-cli';
import { publish, PUBLISH_EXIT_CODES, validateWorkingLayer, VALIDATE_EXIT_CODES } from '../lib/catalog/publish';
import { REVISION_ID_RE } from '../lib/catalog/schema';
import { runSequenceCommand, type CommandResult, type SequenceCommand } from '../lib/catalog/sequence-commands';
import { CREDENTIAL_COMMANDS, credentialUsage, runCredentialCommand } from '../lib/curation/auth/credential-cli';
import { curationUsage, runCurationCli } from '../lib/curation/commands';
import { ApplyRefusedError, migrateApply } from '../lib/identity/apply';
import { createDecision, decisionFileName, isLibraryPath, writeDecision, type DecisionInput } from '../lib/identity/decisions';
import { ASSET_REVISION_RE } from '../lib/identity/ids';
import { DryRunRefusedError, migrateDryRun } from '../lib/identity/migration';
import { jsonLogSink, runReconcilePass } from '../lib/identity/pass';
import { runLegacyDerivativesCommand } from '../lib/identity/legacy-derivatives';
import { identityPaths } from '../lib/identity/registry';
import { LibraryRootMissingError } from '../lib/identity/scan';
import { formatStatus, identityStatus } from '../lib/identity/status';
import { budgetLines, measureInChild } from '../lib/perf/catalog-budgets';
import { configuredLibraryRoot, dataRoot, dataRootStatus, libraryRoot, LibraryRootConfigError } from '../lib/storage/config';
import { isInside } from '../lib/storage/fsx';

/** This CLI the way it was started: the bundle in the image, or the source under tsx. */
const PROGRAM = fileURLToPath(import.meta.url).endsWith('.mjs') ? 'node dist/scripts/photos.mjs' : 'npx tsx scripts/photos.ts';

const USAGE = `Usage:
  ${PROGRAM} migrate --dry-run [--out <dir>]
  ${PROGRAM} migrate --apply --plan <file>
  ${PROGRAM} identity status [--json]
  ${PROGRAM} identity bind <path> <photoId> [--merge <photoId>] [--reason <text>]
  ${PROGRAM} identity new <path> [--reason <text>]
  ${PROGRAM} identity archive <photoId> [--reason <text>]
  ${PROGRAM} identity retry <photoId> [<assetRevision>] [--reason <text>]
  ${PROGRAM} identity reprofile (<photoId> | --all) [--reason <text>]
  ${PROGRAM} status [--json] [--check]
  ${PROGRAM} list [--unassigned] [--json]
  ${PROGRAM} draft:init
  ${PROGRAM} describe --import <file> [--dry-run]
  ${PROGRAM} carry-over [--apply --actor <name>] [--allow-missing <photoId or path>,...]
        One-time setup before the launch publish, only on a library the legacy site served; a fresh library skips it.
  ${PROGRAM} edit (<photoId> | <seriesId> | site) [--file <path>] [--expect-version <N>]
  ${PROGRAM} sequence show <seriesId>
  ${PROGRAM} sequence set <seriesId> <photoId>... [--expect-version <N>]
  ${PROGRAM} sequence (insert | move) <seriesId> <photoId> (--start | --end | --after <photoId> | --to <N>) [--expect-version <N>]
  ${PROGRAM} sequence remove <seriesId> <photoId> [--expect-version <N>]
  ${PROGRAM} sequence cover <seriesId> <photoId> [--focal <x>,<y> | --clear-focal] [--expect-version <N>]
  ${PROGRAM} sequence opening <seriesId> (<photoId> | --clear) [--expect-version <N>]
  ${PROGRAM} sequence chapter add <seriesId> <title> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter move <seriesId> <chapterId> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter remove <seriesId> <chapterId> [--expect-version <N>]
  ${PROGRAM} series order <seriesId>... [--expect-version <N>]
  ${PROGRAM} series featured (<seriesId>... | --clear) [--expect-version <N>]
  ${PROGRAM} validate [--reprofile]
  ${PROGRAM} publish [--actor <name>] [--reason <text>] [--expect <candidateId>] [--dry-run] [--confirm-launch] [--reprofile]
        --confirm-launch is for the launch publish only, a one-time setup step for a new data root, never a routine publish.
  ${PROGRAM} diff [--json]
  ${PROGRAM} review <changeId>... --expect <candidateId> --expect-active <revisionId | none> [--actor <name>]
        Marks the rows photos diff printed reviewed, each named, and rows that share a stamp together; there is no --all.
  ${PROGRAM} review --use-published <changeId> --expect <candidateId> --expect-active <revisionId | none> [--actor <name>]
        Puts the live revision's value back into the draft for one row, as the Publish screen's "Use the published value" does.
  ${PROGRAM} history [--json] [--limit <n>] [--revisions]
  ${PROGRAM} rollback --to <number | revisionId> --reason <text> [--actor <name>] [--accept <ruleId>]... [--expect-active <revisionId>] [--yes]
        --accept, once per editorial rule flagged on the target, brings it back with that error; it's the only flag that repeats.
        --accept verify.failed brings back a revision whose last photos verify failed.
  ${PROGRAM} verify [--revision <revisionId>] [--json]
${curationUsage(PROGRAM)}
  ${PROGRAM} purge <photoId> [--asset-revision <assetRevision>] --reason <text> [--actor <name>] [--yes]
  ${PROGRAM} purge --revoke <tombstoneId> --reason <text> [--actor <name>] [--yes]
        A dry run unless --yes. A tombstone answers 410 at once. Only photos gc --apply deletes the bytes, after 7 days.
  ${PROGRAM} gc [--apply <planDigest>]
  ${PROGRAM} gc --set-aside <assets/photoId/assetRevision>
        Moves that folder, or a .gc- folder beside it, into the data root's trash/. It never deletes.
  ${PROGRAM} legacy-derivatives [--stdout]
        Writes the manifest scripts/host/legacy-move-aside.sh needs; it only reads the library. --stdout also prints it, to save a copy.
${credentialUsage(PROGRAM)}
A flag given twice is refused, except --accept. An argument that starts with - goes after --.
In production: docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>
The README's "Curating the catalog" section has the commands, the hand-edit rules, and the launch checklist.`;

/** A path argument as a library-relative POSIX path. */
function libraryPath(arg: string): string {
    const library = libraryRoot();
    const relative = path.isAbsolute(arg) ? (isInside(arg, library) ? path.relative(library, arg) : '..') : arg;
    const posix = path.posix.normalize(relative.split(path.sep).join('/')).replace(/^(\.\/)+/, '');
    if (!isLibraryPath(posix)) throw new UsageError(`${arg} is not inside the library.`);
    return posix;
}

async function migrate(args: string[]): Promise<number> {
    const { values } = parseFlags({
        args,
        options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, out: { type: 'string' }, plan: { type: 'string' } },
    });
    if (values['dry-run'] && values.apply) throw new UsageError("--dry-run and --apply don't go together.");
    if (values.apply) {
        if (!values.plan) throw new UsageError('--apply needs --plan <file>.');
        if (values.out !== undefined) throw new UsageError('--out goes with --dry-run.');
        const result = await migrateApply({ planPath: values.plan });
        if (result.status === 'already-applied') {
            console.log(`[photos] Plan ${result.planId} is already applied.`);
            console.log(`Mapping: ${result.mappingPath}`);
            return 0;
        }
        console.log(`[photos] Applied plan ${result.planId}: ${result.photos} ${result.photos === 1 ? 'photo' : 'photos'}. The watcher builds the derivatives.`);
        console.log(`Mapping: ${result.mappingPath}`);
        return 0;
    }
    if (!values['dry-run']) throw new UsageError('photos migrate needs --dry-run or --apply.');
    if (values.plan !== undefined) throw new UsageError('--plan goes with --apply.');
    if (values.out === '') throw new UsageError('--out needs a value.');
    const result = await migrateDryRun({ outDir: values.out });
    const counts = new Map<string, number>();
    for (const fact of result.plan.facts) counts.set(fact.type, (counts.get(fact.type) ?? 0) + 1);
    const summary = [...counts.entries()].map(([type, count]) => `${type} ${count}`).join(', ') || 'no facts';
    console.log(`[photos] Dry run over ${result.plan.sources.length} files: ${summary}.`);
    const { unreadableFolders } = result.plan;
    if (unreadableFolders.length > 0) {
        console.warn(`[photos] These folders can't be listed, so their files aren't in the plan: ${unreadableFolders.join(', ')}`);
    }
    console.log(`Plan: ${result.planPath}`);
    console.log(`Report: ${result.reportPath}`);
    return 0;
}

const DECISION_COMMANDS: readonly DecisionInput['type'][] = ['bind', 'new', 'archive', 'retry', 'reprofile'];

function decisionInput(type: DecisionInput['type'], positionals: string[], values: { reason?: string; all?: boolean; merge?: string }): DecisionInput {
    const base = { actor: 'cli', reason: values.reason ?? '' };
    switch (type) {
        case 'bind': {
            if (positionals.length !== 2) throw new UsageError('identity bind needs a path and a photo ID.');
            const photoId = photoIdArg(positionals[1]);
            if (values.merge !== undefined && photoIdArg(values.merge) === photoId) throw new UsageError(`--merge must name a photo other than ${photoId}.`);
            return { ...base, type, path: libraryPath(positionals[0]), photoId, ...(values.merge === undefined ? {} : { merge: values.merge }) };
        }
        case 'new':
            if (positionals.length !== 1) throw new UsageError('identity new needs a path.');
            return { ...base, type, path: libraryPath(positionals[0]) };
        case 'archive':
            if (positionals.length !== 1) throw new UsageError('identity archive needs a photo ID.');
            return { ...base, type, photoId: photoIdArg(positionals[0]) };
        case 'retry': {
            if (positionals.length < 1 || positionals.length > 2) throw new UsageError('identity retry needs a photo ID and takes at most one asset revision.');
            const [photoId, assetRevision] = positionals;
            if (assetRevision !== undefined && !ASSET_REVISION_RE.test(assetRevision)) throw new UsageError(`${assetRevision} is not an asset revision.`);
            return { ...base, type, photoId: photoIdArg(photoId), ...(assetRevision === undefined ? {} : { assetRevision }) };
        }
        case 'reprofile': {
            const all = values.all === true;
            if (all && positionals.length > 0) throw new UsageError('identity reprofile takes a photo ID or --all, not both.');
            if (!all && positionals.length !== 1) throw new UsageError('identity reprofile needs a photo ID or --all.');
            return { ...base, type, ...(all ? {} : { photoId: photoIdArg(positionals[0]) }) };
        }
        case 'restore':
            // Not in DECISION_COMMANDS: the curator restores an archived photograph by approving its duplicate's item (A5).
            throw new UsageError('photos identity has no restore. Approve the duplicate\'s item with curation approve, which writes the restore decision.');
    }
}

/** Write a decision and run a pass that applies it, or leave it for the watcher when the registry is busy. */
async function decide(type: DecisionInput['type'], args: string[]): Promise<number> {
    const { values, positionals } = parseFlags({
        args,
        options: { reason: { type: 'string' }, all: { type: 'boolean' }, merge: { type: 'string' } },
        allowPositionals: true,
    });
    if (values.all !== undefined && type !== 'reprofile') throw new UsageError('--all goes with identity reprofile.');
    if (values.merge !== undefined && type !== 'bind') throw new UsageError('--merge goes with identity bind.');
    const input = decisionInput(type, positionals, values);
    const status = dataRootStatus({ versioned: true });
    if (status.state !== 'ready' || status.root === null) {
        console.error(`[photos] The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.`);
        return 1;
    }
    const decision = createDecision(input);
    const file = await writeDecision(status.root, decision);
    let outcome: Awaited<ReturnType<typeof runReconcilePass>>;
    try {
        outcome = await runReconcilePass({ lock: { waitMs: 0 }, sinks: [jsonLogSink()] });
    } catch (error) {
        // The decision is saved, so running the command again would make a second one, and a second photo for `new`.
        const why = error instanceof LibraryRootMissingError ? `${error.message}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR` : `The pass failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[photos] ${why}. The decision is saved in ${file}, and the next pass that runs applies it. Don't run the command again.`);
        return 1;
    }
    if (outcome.status === 'skipped') {
        if (outcome.reason === 'locked') {
            console.log(`[photos] Saved ${file}. The registry is busy, so the watcher applies it on its next pass.`);
            return 0;
        }
        if (outcome.reason === 'library-empty') {
            console.error(`[photos] The library has no photos, but the registry has ${outcome.present} present, so the pass marked nothing missing and applied nothing. Check the mount and PHOTOGRAPHY_LIBRARY_DIR. The decision is saved in ${file}, and the next pass that runs applies it. Don't run the command again.`);
            return 1;
        }
        if (outcome.reason === 'library-unavailable') {
            const why = outcome.cause === 'missing' ? `Library root not found: ${configuredLibraryRoot()}` : `The library root can't be read (${outcome.detail ?? 'unknown'})`;
            console.error(`[photos] ${why}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. The decision is saved in ${file}, and the next pass that runs applies it. Don't run the command again.`);
            return 1;
        }
        console.error(`[photos] The data root is ${outcome.state}${outcome.detail ? `: ${outcome.detail}` : ''}. The decision is saved in ${file}.`);
        return 1;
    }
    const result = outcome.decisions.find((entry) => entry.decisionId === decision.decisionId);
    if (result === undefined) {
        console.error(`[photos] The pass didn't find ${file}, so the decision wasn't applied.`);
        return 1;
    }
    if (result.status === 'applied') {
        console.log(`[photos] Applied: ${result.detail}.`);
        if (decision.type === 'new') console.log(`Photo ID: ${decision.photoId}`);
        return 0;
    }
    if (result.status === 'deferred') {
        console.log(`[photos] Saved ${file}. It waits because ${result.reason}, and a later pass applies it.`);
        return 0;
    }
    const record = path.join(identityPaths(status.root).decisions, 'rejected', decisionFileName(decision));
    console.error(`[photos] Rejected: ${result.reason}. The record is in ${record}.`);
    return 1;
}

async function identity(args: string[]): Promise<number> {
    const [subcommand, ...rest] = args;
    const decisionType = DECISION_COMMANDS.find((type) => type === subcommand);
    if (decisionType !== undefined) return decide(decisionType, rest);
    if (subcommand !== 'status') throw new UsageError(subcommand ? `Unknown identity command: ${subcommand}` : 'photos identity needs a command.');
    const { values } = parseFlags({ args: rest, options: { json: { type: 'boolean' } } });
    const status = await identityStatus();
    process.stdout.write(values.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return status.dataRoot.state === 'ready' && !status.registryError ? 0 : 1;
}

/** Lines for a command's report: stdout when it succeeded, stderr when it didn't, as the identity commands do. */
function reporter(exitCode: number): (line: string) => void {
    return exitCode === 0 ? (line) => console.log(line) : (line) => console.error(line);
}

/** The data root to compile from, or an exit code after saying why there is none. */
function catalogRoot(): string | number {
    const root = dataRoot();
    if (root !== null) return root;
    const status = dataRootStatus();
    console.error(`[photos] DATA_ROOT_NOT_READY: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    return 3;
}

async function validate(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { reprofile: { type: 'boolean' } } });
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await validateWorkingLayer({ dataRoot: root, reprofile: values.reprofile });
    const exitCode = VALIDATE_EXIT_CODES[result.outcome];
    const print = reporter(exitCode);
    print(`[photos] ${result.outcome}: ${result.message}`);
    if (result.candidateId) print(`Candidate: ${result.candidateId}`);
    for (const line of issueLines(result.issues, 'publish --dry-run writes them all to the diagnostics file.')) print(line);
    if (result.content && result.candidateId) {
        // A warning, never a failure: a child that can't run, or answers in another shape, says so and changes nothing.
        const lines = await measureInChild(result.content, { revisionId: result.candidateId, revisionNumber: null })
            .then((measured) => budgetLines(measured))
            .catch((error: unknown) => budgetLines(error instanceof Error ? error : new Error(String(error))));
        for (const line of lines) print(line);
    }
    return exitCode;
}

async function publishCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({
        args,
        options: {
            actor: { type: 'string' },
            reason: { type: 'string' },
            expect: { type: 'string' },
            'dry-run': { type: 'boolean' },
            'confirm-launch': { type: 'boolean' },
            reprofile: { type: 'boolean' },
        },
    });
    const actor = values.actor ?? process.env.PHOTOS_ACTOR ?? '';
    if (!/\S/.test(actor)) throw new UsageError('photos publish needs --actor <name> or PHOTOS_ACTOR.');
    if (values.reason !== undefined && !/\S/.test(values.reason)) throw new UsageError('--reason needs some text.');
    if (values.expect !== undefined && !REVISION_ID_RE.test(values.expect)) throw new UsageError(`${values.expect} is not a candidate ID.`);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await publish({
        dataRoot: root,
        actor: actor.trim(),
        reason: values.reason?.trim(),
        expectedRevisionId: values.expect,
        dryRun: values['dry-run'],
        confirmLaunch: values['confirm-launch'],
        reprofile: values.reprofile,
    });
    const exitCode = PUBLISH_EXIT_CODES[result.outcome];
    for (const line of publishReport(result, root)) reporter(exitCode)(line);
    return exitCode;
}

/** A catalog command from lib/catalog: its arguments first, then the data root, as validate takes it. */
async function catalogCommand<T>(parse: () => T, run: (root: string, args: T) => Promise<CommandResult>): Promise<number> {
    const parsed = parse();
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await run(root, parsed));
}

async function historyCommand(args: string[]): Promise<number> {
    // With --json, the usage and data-root stops answer in JSON on stdout too, with their exit code.
    const json = args.includes('--json');
    const jsonStop = (result: CommandResult) => {
        process.stdout.write(result.output);
        return result.exitCode;
    };
    let parsed: HistoryArgs;
    try {
        parsed = historyArgs(args);
    } catch (error) {
        if (json && error instanceof UsageError) return jsonStop(historyStop(2, 'USAGE_ERROR', error.message, true));
        throw error;
    }
    if (parsed.json && dataRoot() === null) {
        const status = dataRootStatus();
        return jsonStop(historyStop(3, 'DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`, true));
    }
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await runHistoryCommand(root, parsed);
    if (!parsed.json) return printed(result);
    // JSON goes to stdout whatever the exit code, as verify --json's does.
    process.stdout.write(result.output);
    return result.exitCode;
}

/** Ask a yes-or-no question on the terminal. Only "yes" confirms. */
async function askInTerminal(question: string): Promise<boolean> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return (await terminal.question(question)).trim().toLowerCase() === 'yes';
    } finally {
        terminal.close();
    }
}

async function rollbackCommand(args: string[]): Promise<number> {
    const parsed = rollbackArgs(args);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return runRollbackCommand(root, parsed, {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        confirm: process.stdin.isTTY ? askInTerminal : null,
    });
}

async function verifyCommand(args: string[]): Promise<number> {
    const parsed = verifyArgs(args);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return runVerifyCommand(root, parsed, { out: (line) => console.log(line), err: (line) => console.error(line) });
}

async function purgeCommand(args: string[]): Promise<number> {
    const parsed = purgeArgs(args);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return runPurgeCommand(root, parsed, { out: (line) => console.log(line), err: (line) => console.error(line) });
}

async function gcCommand(args: string[]): Promise<number> {
    const parsed = gcArgs(args);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return runGcCommand(root, parsed, { out: (line) => console.log(line), err: (line) => console.error(line) });
}

async function legacyDerivativesCommand(args: string[]): Promise<number> {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--stdout')) throw new UsageError('photos legacy-derivatives takes only --stdout.');
    const stdout = args[0] === '--stdout';
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    const status = dataRootStatus({ write: true });
    if (status.state !== 'ready') {
        console.error(`[photos] The data root isn't ready (${status.state}${status.detail ? `: ${status.detail}` : ''}). Nothing was written.`);
        return 1;
    }
    const result = await runLegacyDerivativesCommand({ dataRoot: root, library: libraryRoot(), stdout });
    if (result.exitCode !== 0) {
        process.stderr.write(result.output);
        return result.exitCode;
    }
    // With --stdout the manifest is the output, so a redirect saves exactly it, and the summary goes to stderr.
    process.stdout.write(result.output);
    if (stdout) process.stderr.write(result.summary);
    return 0;
}

/** Print a handler's text, on stdout when it succeeded and stderr when it didn't, and return its exit code. */
function printed(result: CommandResult): number {
    (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
    return result.exitCode;
}

/**
 * The data root for the owner commands, or 1 after saying it is unset. These
 * commands use 1 for a data root that isn't ready and 3 only for a busy or
 * lost authored lock and a version conflict, so a wrapper that retries on 3
 * never loops on a missing PHOTOGRAPHY_DATA_DIR.
 */
function ownerRoot(): string | number {
    const root = dataRoot();
    if (root !== null) return root;
    console.error('[photos] The data root is unset: PHOTOGRAPHY_DATA_DIR is not set. Nothing was written.');
    return 1;
}

async function statusCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { json: { type: 'boolean' }, check: { type: 'boolean' } } });
    // status is the diagnostic command, so it reports even with no data root.
    return printed(await runStatusCommand({ dataRoot: dataRoot() }, { json: values.json, check: values.check }));
}

async function listCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { unassigned: { type: 'boolean' }, json: { type: 'boolean' } } });
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runListCommand({ dataRoot: root }, { unassigned: values.unassigned, json: values.json }));
}

async function draftInitCommand(args: string[]): Promise<number> {
    parseFlags({ args, options: {} });
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runDraftInit({ dataRoot: root }));
}

async function describeCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { import: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
    if (!values.import) throw new UsageError('photos describe needs --import <file>.');
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runDescribeImport({ dataRoot: root }, { file: values.import, dryRun: values['dry-run'] }));
}

async function carryOverCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, actor: { type: 'string' }, 'allow-missing': { type: 'string' } } });
    if (values.apply && values['dry-run']) throw new UsageError('photos carry-over takes --apply or --dry-run, not both.');
    const actor = values.actor ?? process.env.PHOTOS_ACTOR ?? '';
    if (values.apply && !/\S/.test(actor)) throw new UsageError('photos carry-over --apply needs --actor <name> or PHOTOS_ACTOR.');
    const allow = (values['allow-missing'] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    if (values['allow-missing'] !== undefined && allow.length === 0) throw new UsageError('--allow-missing needs photo IDs or library paths, separated by commas.');
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runCarryOver({ dataRoot: root }, { apply: values.apply, actor: actor.trim(), allow }));
}

async function editCommand(args: string[]): Promise<number> {
    const { values, positionals } = parseFlags({ args, options: { file: { type: 'string' }, 'expect-version': { type: 'string' } }, allowPositionals: true });
    if (positionals.length !== 1) throw new UsageError('photos edit needs one record: a photo ID, a series ID, or site.');
    const ref = recordRef(positionals[0]);
    if (ref === null) throw new UsageError(`${positionals[0]} is not a photo ID, a series ID, or site.`);
    if (values.file === '') throw new UsageError('--file needs a path.');
    const expect = values['expect-version'];
    if (expect !== undefined && !/^\d+$/.test(expect)) throw new UsageError('--expect-version takes a version from 0.');
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runEditRecord({ dataRoot: root }, ref, { file: values.file, expectVersion: expect === undefined ? undefined : Number(expect) }));
}

async function orderCommand(parse: () => SequenceCommand): Promise<number> {
    const command = parse();
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runSequenceCommand({ dataRoot: root }, command));
}

async function main(argv: string[]): Promise<number> {
    const [command, ...args] = argv;
    try {
        if (command === 'migrate') return await migrate(args);
        if (command === 'identity') return await identity(args);
        if (command === 'status') return await statusCommand(args);
        if (command === 'list') return await listCommand(args);
        if (command === 'draft:init') return await draftInitCommand(args);
        if (command === 'describe') return await describeCommand(args);
        if (command === 'carry-over') return await carryOverCommand(args);
        if (command === 'edit') return await editCommand(args);
        if (command === 'sequence') return await orderCommand(() => sequenceArgs(args));
        if (command === 'series') return await orderCommand(() => seriesArgs(args));
        if (command === 'validate') return await validate(args);
        if (command === 'publish') return await publishCommand(args);
        if (command === 'diff') return await catalogCommand(() => diffArgs(args), runDiffCommand);
        if (command === 'review') return await catalogCommand(() => reviewArgs(args), runReviewCommand);
        if (command === 'history') return await historyCommand(args);
        if (command === 'rollback') return await rollbackCommand(args);
        if (command === 'verify') return await verifyCommand(args);
        if (command === 'curation' && (CREDENTIAL_COMMANDS as readonly string[]).includes(args[0] ?? '')) {
            const result = await runCredentialCommand(args[0] as (typeof CREDENTIAL_COMMANDS)[number], args.slice(1), { stdin: process.stdin, stderr: process.stderr });
            (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
            return result.exitCode;
        }
        if (command === 'curation') {
            const result = await runCurationCli(args, { dataRoot: dataRoot(), libraryRoot: configuredLibraryRoot(), program: PROGRAM });
            (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
            return result.exitCode;
        }
        if (command === 'purge') return await purgeCommand(args);
        if (command === 'gc') return await gcCommand(args);
        if (command === 'legacy-derivatives') return await legacyDerivativesCommand(args);
        throw new UsageError(command ? `Unknown command: ${command}` : 'No command given.');
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`[photos] ${error.message}\n${USAGE}`);
            return 2;
        }
        if (error instanceof DryRunRefusedError || error instanceof ApplyRefusedError) {
            console.error(`[photos] ${error.message}`);
            return error.exitCode;
        }
        if (error instanceof LibraryRootMissingError) {
            console.error(`[photos] ${error.message}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was written.`);
            return 1;
        }
        if (error instanceof LibraryRootConfigError) {
            console.error(`[photos] ${error.message} Nothing was written.`);
            return 1;
        }
        throw error;
    }
}

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error: unknown) => {
        console.error('[photos] Error:', error);
        process.exitCode = 1;
    });
