/**
 * Writes #6's budget library (lib/perf/fixture.ts) to an empty data root
 * outside the repository and publishes it, for a browser run by hand:
 *
 *   npm run fixtures:catalog -- --out <empty dir> [--photos 5000] [--variant a|b] [--seed 6]
 *
 * `--photos 500` keeps the 100 series and the featured 100 and shrinks the
 * rest. `--variant b` writes the same library with the long series
 * reordered and a photograph dropped from the 101, as its own root: a
 * revision-change run serves the two side by side. At 5,000 photographs it's
 * about 45,000 files and takes minutes. Serve it with
 * `PHOTOGRAPHY_DATA_DIR=<dir> npm run start`.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { publishBudgetLibrary } from './library';

const { values } = parseArgs({
    options: { out: { type: 'string' }, photos: { type: 'string' }, variant: { type: 'string' }, seed: { type: 'string' } },
    strict: true,
});
const whole = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`--${flag} needs a whole number, got ${value}.`);
    return Number(value);
};
if (!values.out) throw new Error('Usage: npm run fixtures:catalog -- --out <empty dir> [--photos 5000] [--variant a|b] [--seed 6]');
if (values.variant !== undefined && values.variant !== 'a' && values.variant !== 'b') throw new Error(`--variant is a or b, got ${values.variant}.`);

const root = path.resolve(values.out);
const started = performance.now();
const revisionId = await publishBudgetLibrary(root, { photos: whole('photos', values.photos), variant: values.variant, seed: whole('seed', values.seed) });
console.log(`Published the budget library to ${root} as ${revisionId} in ${Math.round((performance.now() - started) / 1000)} s.`);
