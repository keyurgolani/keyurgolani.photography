// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetReference } from '../../catalog/references';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { photoHolderEntries, photoHolders } from '../holders';
import { createCurationFixture, DRAFT, PUBLISHED, type CurationFixture } from './curationFixtures';

// Who holds a photograph is only the active revision and the working layer's
// series. A photo record, a candidate, or an older revision names the photo
// too, but none of them shows it, so none of them may count as a holder.

let fixture: CurationFixture | null = null;
afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
});

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const ACTIVE = `rev_${'a'.repeat(64)}`;
const OLDER = `rev_${'b'.repeat(64)}`;
const CANDIDATE = `rev_${'c'.repeat(64)}`;
const ASSET = `sha256-${'d'.repeat(64)}`;
const OTHER_ASSET = `sha256-${'e'.repeat(64)}`;
const ref = (source: AssetReference['source'], holder: string, extra: Partial<AssetReference> = {}): AssetReference => ({ source, holder, photoId: PHOTO, assetRevision: ASSET, profileId: null, ...extra });

describe('photoHolderEntries', () => {
    it('counts only the active revision and working-layer series in a real data root, not the photo record itself', async () => {
        fixture = await createCurationFixture({ published: true });
        const { catalog } = fixture;
        const published = catalog.content.series.find((series) => series.id === PUBLISHED)!.photoIds[0];
        const found = await photoHolderEntries(fixture.root, published);
        expect(found).toEqual({ entries: [{ kind: 'revision', id: catalog.revisionId }, { kind: 'series', id: PUBLISHED }] });
        expect(await photoHolders(fixture.root, published)).toEqual({ holders: [`the active revision ${catalog.revisionId}`, `the series ${PUBLISHED}`] });

        // A draft-series photo has its own photo record too; only the series holds it.
        const draftMember = (await readAuthoredRecord(fixture.root, 'series', DRAFT))!.photoIds[0];
        expect(await photoHolderEntries(fixture.root, draftMember)).toEqual({ entries: [{ kind: 'series', id: DRAFT }] });
        // A photo the registry holds and the working layer doesn't has no holder.
        expect(await photoHolderEntries(fixture.root, fixture.fresh[0])).toEqual({ entries: [] });
    });

    it('drops a photo record, a candidate, and an older revision, each of which names the photo', async () => {
        const list = [ref('revision', OLDER, { profileId: 'p_1' }), ref('candidate', CANDIDATE, { profileId: 'p_1' }), ref('working-layer-photo', PHOTO)];
        expect(await photoHolderEntries('/nonexistent', PHOTO, { list })).toEqual({ entries: [] });
        expect(await photoHolders('/nonexistent', PHOTO, { list })).toEqual({ holders: [] });
    });

    it('lists each holder once, in scan order, when it names the photo more than once', async () => {
        const list = [
            ref('active-revision', ACTIVE, { profileId: 'p_1' }),
            ref('active-revision', ACTIVE, { profileId: 'p_2' }),
            ref('active-revision', ACTIVE, { assetRevision: OTHER_ASSET, profileId: 'p_1' }),
            ref('working-layer-series', 'ser_harbor'),
            ref('working-layer-series', 'ser_harbor', { assetRevision: null }),
            ref('working-layer-series', 'ser_draft'),
            ref('active-revision', ACTIVE, { photoId: 'ph_00000000-0000-4000-8000-000000000002', profileId: 'p_1' }),
        ];
        expect(await photoHolderEntries('/nonexistent', PHOTO, { list })).toEqual({
            entries: [{ kind: 'revision', id: ACTIVE }, { kind: 'series', id: 'ser_harbor' }, { kind: 'series', id: 'ser_draft' }],
        });
        expect(await photoHolders('/nonexistent', PHOTO, { list })).toEqual({ holders: [`the active revision ${ACTIVE}`, 'the series ser_harbor', 'the series ser_draft'] });
    });

    it('keeps a revision and a series that share an ID apart', async () => {
        const list = [ref('active-revision', 'same'), ref('working-layer-series', 'same')];
        expect(await photoHolderEntries('/nonexistent', PHOTO, { list })).toEqual({ entries: [{ kind: 'revision', id: 'same' }, { kind: 'series', id: 'same' }] });
    });
});
