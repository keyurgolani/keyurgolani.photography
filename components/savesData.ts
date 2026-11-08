/**
 * Whether the visitor asked the browser to save data (`navigator.connection.saveData`, #174): then nothing is fetched
 * ahead of what they asked for. Read at each call, so a change mid-visit counts at the next one. False on the server,
 * and in a browser that doesn't say.
 */
export function savesData(): boolean {
    if (typeof navigator === 'undefined') return false;
    return (navigator as Navigator & { connection?: { saveData?: unknown } }).connection?.saveData === true;
}
