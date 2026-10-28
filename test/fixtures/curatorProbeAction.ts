import fs from 'node:fs';
import path from 'node:path';
import { requireCurator } from '../../lib/curation/auth';

/**
 * A stand-in curator server action for the route-inventory test, shaped the
 * way #14's 14-3 writes its actions: requireCurator() first, then a write to
 * the data root. The test calls it with the boundary's checks failing and
 * passing, so it proves the harness sees a write when one happens. Not under
 * app/, so Next never builds it.
 */
export async function probeWrite(): Promise<void> {
    await requireCurator();
    const root = process.env.PHOTOGRAPHY_DATA_DIR;
    if (!root) throw new Error('PHOTOGRAPHY_DATA_DIR is unset.');
    fs.mkdirSync(path.join(root, 'curation'), { recursive: true });
    fs.writeFileSync(path.join(root, 'curation', 'probe.json'), '{}\n');
}
