import { writerGate } from '../../catalog/data-root-owner';
import { dataRoot } from '../../storage/config';

/**
 * The A11 coordinator's round 3b: the curator, the same server as web with
 * CURATION_ENABLED=true, writes the data root (Inbox items, decisions,
 * working-layer records, their locks), so it starts only as the data root's
 * owner, uid 1001 under docker-compose.prod.yml. It sits in the auth
 * boundary, which public entries may load, and loads no other curation
 * module. instrumentation.ts asks
 * here first, before any other startup step and before the curator's first
 * lock or write, and stops the process on a refusal. Visitor web, without
 * CURATION_ENABLED, takes no lock and writes nothing under the data root, so
 * it isn't asked.
 */
export function curatorOwnerProblem(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
    if (env.CURATION_ENABLED !== 'true') return null;
    return writerGate(dataRoot(), 'the curator', 'curator');
}
