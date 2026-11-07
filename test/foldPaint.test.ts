import { describe, expect, it } from 'vitest';
import { FOLD_PAINT } from './helpers/parityWalk';

// A folded element (test/helpers/parityWalk.ts's WalkOptions.fold) is left out of the parity walk, so it may paint nothing its parent
// doesn't. Its ::before and ::after, where they render, may carry no text either: their `content` is pinned to the empty
// string, which Work's stretched title link's ::after has (B8's review of the Viewer heading's fold).
describe("a folded element's pseudo-elements", () => {
    it('render no text: their content is pinned to the empty string', () => {
        expect(FOLD_PAINT.pseudo).toMatchObject({ content: '""' });
    });
});
