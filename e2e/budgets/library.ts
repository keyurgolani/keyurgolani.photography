import { publish } from '../../lib/catalog/publish';
import { readRevisionFile } from '../../lib/catalog/repository';
import { createTestCatalog } from '../../lib/catalog/testing';
import type { RevisionContent } from '../../lib/catalog/types';
import { readActivePointer } from '../../lib/catalog/working-layer';
import { budgetFixtureOptions, type BudgetFixtureOptions } from '../../lib/perf/fixture';

/**
 * The budget library on disk, for `npm run test:budgets` and
 * `npm run fixtures:catalog`: lib/perf/fixture.ts's catalog written to an
 * empty data root outside the repository, manifests and sparse variant files
 * included, and published as its first revision.
 */
export async function publishBudgetLibrary(root: string, options: BudgetFixtureOptions = {}): Promise<string> {
    const catalog = await createTestCatalog({ ...budgetFixtureOptions(options), root });
    const result = await publish({ dataRoot: catalog.root, actor: 'budgets', reason: 'budget fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (result.outcome !== 'PUBLISHED' || result.revisionId === null) {
        throw new Error(`The budget library didn't publish: ${result.outcome}: ${result.message} ${result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code).join(', ')}`);
    }
    return result.revisionId;
}

/** The revision a data root serves, read as the site reads it, writing nothing. */
export async function activeRevision(root: string): Promise<{ revisionId: string; content: RevisionContent }> {
    const pointer = await readActivePointer(root);
    if (!pointer) throw new Error(`${root} has published nothing, so there's nothing to measure.`);
    const revision = await readRevisionFile(root, pointer.revisionId);
    if (!revision) throw new Error(`${root}'s active pointer names ${pointer.revisionId}, which has no revision file.`);
    return { revisionId: revision.revisionId, content: revision.content };
}
