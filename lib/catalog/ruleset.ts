import './asset-rules';
import './review-rules';

/**
 * The rule runner for every process: rules.ts's registry with every rule
 * module registered, so publish, validate, a rollback check, and #15's
 * verify run the same rules and record the same rulesetVersion. rules.ts
 * alone has #13's and #8's rules but not the asset rules or #16's review
 * rules. Only its own tests may run rules from it, and lint refuses
 * runRules, rulesetVersion, and registeredRules from rules.ts anywhere
 * else. A rule module added later is imported here.
 */

export { registeredRules, rulesetVersion, runRules } from './rules';
