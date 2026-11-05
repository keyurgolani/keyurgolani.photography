/**
 * A9's text diff for the Publish screen (#182): the words a change keeps,
 * removes and adds, which the screen shows as `<del>` and `<ins>`. Pure and
 * client-safe. Words and the spaces between them are the units, so a
 * changed word reads whole, and runs of one kind are merged.
 *
 * It's a longest common subsequence over the two token lists, bounded: past
 * TEXT_DIFF_MAX_CELLS (about 500 by 500 tokens, a long statement each side)
 * it gives the whole old text removed and the whole new one added, so a
 * page load never spends long on one row.
 */

export type TextPart = { type: 'same' | 'removed' | 'added'; text: string };

export const TEXT_DIFF_MAX_CELLS = 250_000;

const tokens = (text: string) => text.split(/(\s+)/).filter((token) => token !== '');

function push(parts: TextPart[], type: TextPart['type'], text: string): void {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
}

export function textDiff(before: string | null, after: string | null): TextPart[] {
    if (!before && !after) return [];
    if (!before) return [{ type: 'added', text: after as string }];
    if (!after) return [{ type: 'removed', text: before }];
    if (before === after) return [{ type: 'same', text: before }];
    const a = tokens(before);
    const b = tokens(after);
    if (a.length * b.length > TEXT_DIFF_MAX_CELLS) return [{ type: 'removed', text: before }, { type: 'added', text: after }];
    // lengths[i][j]: the longest common run of a[i..] and b[j..], row by row in one flat array.
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
    }
    const parts: TextPart[] = [];
    let i = 0;
    let j = 0;
    // Removals before additions at each point, so the old words read first.
    let removed = '';
    let added = '';
    const flush = () => {
        if (removed) push(parts, 'removed', removed);
        if (added) push(parts, 'added', added);
        removed = '';
        added = '';
    };
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            flush();
            push(parts, 'same', a[i]);
            i += 1;
            j += 1;
        } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
            removed += a[i++];
        } else {
            added += b[j++];
        }
    }
    while (i < a.length) removed += a[i++];
    while (j < b.length) added += b[j++];
    flush();
    return parts;
}
