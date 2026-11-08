import { randomInt } from 'node:crypto';
import type { HomePick } from './projections/home';
import { globalSlot, slotKey } from '../globalSlot';

/**
 * TEST ONLY. The e2e harness sets this on a test server it starts
 * (e2e/home-variety.spec.ts, through e2e/support/catalogServer.ts), so a
 * spec can say exactly which featured series each load of Home starts on
 * instead of counting on chance. Production never sets it: no Dockerfile,
 * Compose file, workflow or doc does, and it chooses nothing else.
 *
 * It holds whole numbers separated by commas, such as `2,0,1`. Each render
 * of Home or the curator's preview of it takes the next one, modulo the
 * number of featured series that resolve, and after the last starts again
 * from the first. Unset, empty or anything else, Home picks with
 * crypto.randomInt.
 */
export const TEST_HOME_PICK_ENV = 'PHOTOGRAPHY_TEST_HOME_PICK';

const SCRIPT_RE = /^\d{1,6}(,\d{1,6})*$/;

/** Where the scripted sequence is, per script, on globalThis so every route bundle in the server shares one place. */
type Cursors = Map<string, number>;
const CURSORS = slotKey<Cursors>(Symbol.for('keyurgolani.photography.testHomePick'));

function cursors(): Cursors {
    return globalSlot<Cursors>(CURSORS, () => new Map());
}

/**
 * The random source Home starts its loop with: crypto.randomInt, or under
 * the test-only TEST_HOME_PICK_ENV, its next scripted index. Read per
 * render, so a page never caches the choice.
 */
export function homeStartPick(env: Record<string, string | undefined> = process.env): HomePick {
    const script = env[TEST_HOME_PICK_ENV]?.trim();
    if (!script || !SCRIPT_RE.test(script)) return randomInt;
    const indexes = script.split(',').map(Number);
    return (count) => {
        const at = cursors().get(script) ?? 0;
        cursors().set(script, (at + 1) % indexes.length);
        return indexes[at] % count;
    };
}

/** TEST ONLY: forgets every script's place, so a test's first render takes its script's first index. */
export function resetHomeStartPickForTests(): void {
    cursors().clear();
}
