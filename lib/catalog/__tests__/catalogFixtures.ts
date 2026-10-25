import fs from 'node:fs';
import path from 'node:path';
import type { AssetManifest, Registry } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { MANIFEST_FILE } from '../../storage/publish';
import { assetDir } from '../../media/path';
import type { VariantByteTable } from '../testing';
import type { AuthoredKind } from '../schema';
import { authoredRecordDir } from '../working-layer';
import { versionFile } from '../../storage/document';

/** Sparse variant sizes for createTestCatalog(): small, a different size per file, and quick to write. */
export const VARIANT_BYTES = Object.fromEntries(
    VARIANT_WIDTHS.map((width, w) => [width, Object.fromEntries(VARIANT_FORMATS.map((format, f) => [format, 1_000 + w * 10 + f]))]),
) as VariantByteTable;

/** A profile ID no fixture uses, standing in for #10's current profile after a recipe change. */
export const NEW_PROFILE = 'p_00000000000000ff';

/** The asset revision a photo's authored record pins in a fixture: its only one. */
export function pinnedRevision(registry: Registry, photoId: string): string {
    const [assetRevision] = Object.keys(registry.photos[photoId].revisions);
    return assetRevision;
}

/**
 * Give a photo's pinned revision another ready derivative set under
 * `profileId`: a copy of the set it has under `fromProfileId`, with its
 * manifest renamed, and a ready registry entry. Changes `registry` in place.
 */
export function addReadyProfile(root: string, registry: Registry, photoId: string, { profileId, fromProfileId, readyAt }: { profileId: string; fromProfileId: string; readyAt: string }): void {
    const assetRevision = pinnedRevision(registry, photoId);
    const from = assetDir({ photoId, assetRevision, profileId: fromProfileId }, root);
    const to = assetDir({ photoId, assetRevision, profileId }, root);
    fs.cpSync(from, to, { recursive: true });
    const manifestFile = path.join(to, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as AssetManifest;
    fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, profileId }, null, 2)}\n`);
    registry.photos[photoId].revisions[assetRevision].profiles[profileId] = { state: 'ready', attempts: 1, readyAt };
}

/** The newest version file of an authored record, `v0.json` (absent) when it has none, for tests that compare its bytes. */
export function newestRecordFile(root: string, kind: AuthoredKind, id: string): string {
    const dir = authoredRecordDir(root, kind, id);
    const versions = fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((name) => /^v([1-9]\d*)\.json$/.exec(name)?.[1] ?? []).map(Number) : [];
    return versionFile(dir, Math.max(0, ...versions));
}
