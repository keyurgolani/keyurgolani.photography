/** One row of the Viewer's details list: its dt's text and its dd's. */
export type FactRow = [label: string, value: string];

/** The base's row that the head merges into Camera (#175, B8): "Camera make" and "Camera" are one Camera row. */
export const CAMERA_MAKE = 'Camera make';

/** The Viewer's details list rows on the page, read the same way in both builds. */
export const FACT_ROWS = '[data-surface="viewer"] dl > div';

/**
 * The rows whose value gains #175's unit (B8), by label: the base's text, then the head's, for the parity fixture's
 * camera facts. Exact strings, with U+0020 spaces, compared with === only. A no-break or narrow space would be a new
 * departure, written with \u escapes.
 */
export const UNIT_ROWS: Readonly<Record<string, readonly [base: string, head: string]>> = Object.freeze({
    'Focal length': Object.freeze(['35', '35 mm'] as const),
    Aperture: Object.freeze(['2.8', 'f/2.8'] as const),
    Exposure: Object.freeze(['1/250', '1/250 s'] as const),
});

/**
 * Dark parity's sanctioned departure on the Viewer's details list (#175, B8). The head has one row fewer, since the
 * base's Camera make row merged into Camera, and three values gain their units. The walk leaves out the base's first
 * row, so the rest keep their paths; this checks:
 * - that row is the base's one Camera make row, and the head has none;
 * - each UNIT_ROWS label is in each list exactly once;
 * - a unit row has the same label in both, the base's value is the table's base string and the head's is its head
 *   string, exactly;
 * - every other row's label and value are byte-equal, in order.
 * `record` lists both builds' rows and each unit row, for the report's sanctioned departures.
 */
export function cameraRowDeparture(base: FactRow[], head: FactRow[]): { failing: string[]; record: string[] } {
    const failing: string[] = [];
    const makes = base.filter(([label]) => label === CAMERA_MAKE).length;
    const at = base.findIndex(([label]) => label === CAMERA_MAKE);
    if (makes !== 1) failing.push(`the base has ${makes} Camera make rows, not 1`);
    else if (at !== 0) failing.push(`the base's Camera make row is row ${at + 1}, not the first, which the walk leaves out`);
    if (head.some(([label]) => label === CAMERA_MAKE)) failing.push('the head still has a Camera make row');
    for (const label of Object.keys(UNIT_ROWS)) {
        for (const [build, rows] of [['base', base], ['head', head]] as const) {
            const count = rows.filter(([name]) => name === label).length;
            if (count !== 1) failing.push(`the ${build} has ${count} ${label} rows, not 1`);
        }
    }
    const rest = base.filter(([label]) => label !== CAMERA_MAKE);
    if (rest.length !== head.length) failing.push(`${rest.length} other rows in the base against ${head.length} in the head`);
    const text = (row: FactRow | undefined) => (row ? `"${row[0]}: ${row[1]}"` : 'nothing');
    for (let i = 0; i < Math.max(rest.length, head.length); i++) {
        const [b, h] = [rest[i], head[i]];
        const unit = b && Object.hasOwn(UNIT_ROWS, b[0]) ? UNIT_ROWS[b[0]] : null;
        const same = b !== undefined && h !== undefined && b[0] === h[0] && (unit ? b[1] === unit[0] && h[1] === unit[1] : b[1] === h[1]);
        if (!same) failing.push(`row ${i + 1}: ${text(b)} in the base against ${text(h)} in the head${unit ? `, where #175's departure is "${b[0]}: ${unit[0]}" against "${b[0]}: ${unit[1]}"` : ''}`);
    }
    const list = (rows: FactRow[]) => rows.map(([label, value]) => `${label}: ${value}`).join(' | ');
    return {
        failing,
        record: [
            `base rows (${base.length}): ${list(base)}`,
            `head rows (${head.length}): ${list(head)}`,
            ...Object.entries(UNIT_ROWS).map(([label, [from, to]]) => `${label}: "${from}" in the base, "${to}" in the head`),
        ],
    };
}
