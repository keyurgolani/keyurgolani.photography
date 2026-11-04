import { randomUUID } from 'node:crypto';
import { validateStored } from '../../lib/catalog/publish';
import { listActivations, readRevisionFile, revisionNumberFor, writeActivation, writeActivePointer, writeRevisionIfAbsent } from '../../lib/catalog/repository';
import { CATALOG_SCHEMA_VERSION, revisionIdOf } from '../../lib/catalog/schema';
import type { Activation, RevisionContent, RevisionFile } from '../../lib/catalog/types';
import { readActivePointer } from '../../lib/catalog/working-layer';
import { readRegistry } from '../../lib/identity/registry';

/**
 * Publish a revision by hand: the live revision's content with `change` made
 * to it, written through the repository's own writers (the revision file, a
 * pending then committed publish activation, and the pointer between them),
 * so the files parse and hash as publish() would leave them. publish() itself
 * refuses a revision today's rules flag, and a stored one that carries such
 * an error is what a rollback's acceptance is for: a revision that went live
 * under older rules. Its validation counts are today's, from validateStored().
 * Test data only. Returns the new revision's ID.
 */
export async function publishByHand(root: string, change: (content: RevisionContent) => void, { actor = 'keyur', reason = 'published by hand' }: { actor?: string; reason?: string } = {}): Promise<string> {
    const pointer = await readActivePointer(root);
    if (pointer === null) throw new Error('Nothing is live to publish on top of.');
    const live = await readRevisionFile(root, pointer.revisionId);
    if (live === null) throw new Error(`${pointer.revisionId} has no revision file.`);
    const content = structuredClone(live.content);
    change(content);
    const revisionId = revisionIdOf(content);
    const now = new Date().toISOString();
    const revision: RevisionFile = { schemaVersion: CATALOG_SCHEMA_VERSION, revisionId, baseRevisionId: live.revisionId, compiledAt: now, content };
    await writeRevisionIfAbsent(root, revision);
    const activations = await listActivations(root);
    const { validation } = validateStored(root, revision, await readRegistry(root));
    const pending: Activation = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        activationId: `act_${randomUUID()}`,
        sequence: activations.reduce((highest, activation) => Math.max(highest, activation.sequence), 0) + 1,
        kind: 'publish',
        status: 'pending',
        revisionId,
        revisionNumber: revisionNumberFor(activations, revisionId),
        previousRevisionId: pointer.revisionId,
        previousActivationId: pointer.activationId,
        actor,
        reason,
        startedAt: now,
        validation,
        acceptedRules: [],
        lockTakeover: null,
    };
    await writeActivation(root, pending);
    await writeActivePointer(root, { revisionId, activationId: pending.activationId }, pointer.version);
    await writeActivation(root, { ...pending, status: 'committed', committedAt: new Date().toISOString() });
    return revisionId;
}
