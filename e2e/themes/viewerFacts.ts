/** One row of the Viewer's details list: its dt's text and its dd's. */
export type FactRow = [label: string, value: string];

/** The base's row that the head merges into Camera (#175, B8): "Camera make" and "Camera" are one Camera row. */
export const CAMERA_MAKE = 'Camera make';

/** The Viewer's details list rows on the page, read the same way in both builds. */
export const FACT_ROWS = '[data-surface="viewer"] dl > div';

/**
 * Dark parity's sanctioned departure on the Viewer's details list (#175, B8): the head has one row fewer, since the
 * base's Camera make row merged into Camera. The walk leaves out the base's first row, so the rest keep their paths;
 * this checks it is the Camera make row, that the head has none, and that every other row's label and value are the
 * same, in order. `record` lists both builds' rows, for the report's sanctioned departures.
 */
export function cameraRowDeparture(base: FactRow[], head: FactRow[]): { failing: string[]; record: string[] } {
    const failing: string[] = [];
    const makes = base.filter(([label]) => label === CAMERA_MAKE).length;
    const at = base.findIndex(([label]) => label === CAMERA_MAKE);
    if (makes !== 1) failing.push(`the base has ${makes} Camera make rows, not 1`);
    else if (at !== 0) failing.push(`the base's Camera make row is row ${at + 1}, not the first, which the walk leaves out`);
    if (head.some(([label]) => label === CAMERA_MAKE)) failing.push('the head still has a Camera make row');
    const rest = base.filter(([label]) => label !== CAMERA_MAKE);
    if (rest.length !== head.length) failing.push(`${rest.length} other rows in the base against ${head.length} in the head`);
    const text = (row: FactRow | undefined) => (row ? `"${row[0]}: ${row[1]}"` : 'nothing');
    for (let i = 0; i < Math.max(rest.length, head.length); i++) {
        const [b, h] = [rest[i], head[i]];
        if (!b || !h || b[0] !== h[0] || b[1] !== h[1]) failing.push(`row ${i + 1}: ${text(b)} in the base against ${text(h)} in the head`);
    }
    const list = (rows: FactRow[]) => rows.map(([label, value]) => `${label}: ${value}`).join(' | ');
    return { failing, record: [`base rows (${base.length}): ${list(base)}`, `head rows (${head.length}): ${list(head)}`] };
}
