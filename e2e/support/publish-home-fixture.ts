/**
 * Publishes the catalog Home fixture (homeFixture.ts) into an empty data
 * root, for the catalog-mode server in playwright.config.ts:
 *
 *   npx tsx e2e/support/publish-home-fixture.ts <empty data root outside the repository>
 *
 * The featured series' order and opening come from
 * e2e/support/catalog-home.ts, which the specs check against.
 */
import { publishHomeFixture } from './homeFixture';

const root = process.argv[2];
if (!root) throw new Error('Usage: publish-home-fixture.ts <empty data root>');

const { revisionId } = await publishHomeFixture(root);
console.log(`Published the Home fixture as ${revisionId}.`);
