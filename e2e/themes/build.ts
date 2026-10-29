import { spawnSync } from 'node:child_process';

/**
 * The parity run's global setup. With PARITY_BUILD=1 (CI's Themes job) it builds the head (this checkout) and the base
 * (PARITY_BASE_DIR) first, under the same env the Playwright servers build with: ALLOW_PROVISIONAL_COPY lets a
 * production build run on About's placeholder copy, and belongs to the Playwright servers only (playwright.config.ts),
 * never in a workflow. Locally, build both yourself and leave PARITY_BUILD unset.
 */
export default function build() {
    if (process.env.PARITY_BUILD !== '1') return;
    const base = process.env.PARITY_BASE_DIR;
    if (!base) throw new Error('PARITY_BUILD=1 needs PARITY_BASE_DIR, a checkout of the base with its dependencies installed.');
    for (const tree of [process.cwd(), base]) {
        const built = spawnSync('npm', ['run', 'build'], { cwd: tree, stdio: 'inherit', env: { ...process.env, ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1' } });
        if (built.status !== 0) throw new Error(`npm run build failed in ${tree}`);
    }
}
