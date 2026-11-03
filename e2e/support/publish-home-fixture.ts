/**
 * Publishes the catalog Home fixture (homeFixture.ts) into an empty data
 * root, for the catalog-mode server in playwright.config.ts:
 *
 *   npx tsx e2e/support/publish-home-fixture.ts <empty data root outside the repository> [--variety]
 *
 * The featured series' order and opening come from
 * e2e/support/catalog-home.ts, which the specs check against. `--variety`
 * publishes the three-featured fixture instead, as a perf run of Home's loop
 * does.
 */
import { publishHomeFixture, publishHomeVarietyFixture } from './homeFixture';

const root = process.argv[2];
if (!root) throw new Error('Usage: publish-home-fixture.ts <empty data root> [--variety]');

const variety = process.argv[3] === '--variety';
const { revisionId } = await (variety ? publishHomeVarietyFixture : publishHomeFixture)(root);
console.log(`Published the Home ${variety ? 'variety ' : ''}fixture as ${revisionId}.`);
