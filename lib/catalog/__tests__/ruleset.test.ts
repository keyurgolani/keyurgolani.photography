// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LAUNCH_ORDER_RULE_IDS } from '../order-rules';
import { registeredRules } from '../ruleset';

// Only ruleset.ts here, so nothing else in this file registers the asset rules.
const ASSET_RULES = ['assets.manifest', 'assets.ready', 'assets.revision', 'assets.size', 'assets.url', 'assets.variant'];

describe('ruleset.ts', () => {
    it('registers every rule module, the asset rules and #8\'s order rules included, for whoever runs rules through it', () => {
        const ids = registeredRules().map((rule) => rule.id);
        expect(ids.filter((id) => id.startsWith('assets.'))).toEqual(ASSET_RULES);
        expect(ids).toEqual(expect.arrayContaining([...LAUNCH_ORDER_RULE_IDS, 'description.required']));
    });
});
