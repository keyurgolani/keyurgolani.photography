import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import writePhotoFixtures from '../support/global-setup';

/**
 * The parity run's global setup. With PARITY_BUILD=1 (CI's Themes job) it builds the head (this checkout) and the base
 * (PARITY_BASE_DIR) first, under the same env the Playwright servers build with: ALLOW_PROVISIONAL_COPY lets a
 * production build run on About's placeholder copy, and belongs to the Playwright servers only (playwright.config.ts),
 * never in a workflow. Locally, build both yourself and leave PARITY_BUILD unset. Either way it empties the report's
 * rows, which the spec appends to as it measures, and writes the e2e suite's photo fixtures for the legacy Gallery.
 */
export default async function build(): Promise<() => Promise<void>> {
    // Emptied, not deleted: the report's rows start over each run.
    const out = path.join(process.cwd(), 'test-results', 'parity');
    fs.mkdirSync(out, { recursive: true });
    for (const file of ['black-parity.rows', 'black-parity.rects', 'black-styles.rows', 'black-styles.details']) fs.writeFileSync(path.join(out, file), '');
    const removeFixtures = await writePhotoFixtures();
    if (process.env.PARITY_BUILD !== '1') return removeFixtures;
    const base = process.env.PARITY_BASE_DIR;
    if (!base) throw new Error('PARITY_BUILD=1 needs PARITY_BASE_DIR, a checkout of the base with its dependencies installed.');
    for (const tree of [process.cwd(), base]) {
        const built = spawnSync('npm', ['run', 'build'], { cwd: tree, stdio: 'inherit', env: { ...process.env, ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1' } });
        if (built.status !== 0) throw new Error(`npm run build failed in ${tree}`);
    }
    return removeFixtures;
}
