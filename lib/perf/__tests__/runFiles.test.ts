// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDiskFloor, freeGb, isReadOnly, makeReadOnly, makeRunTemp, removeRunTemp } from '../runFiles';

const made: string[] = [];
const temp = (prefix: string) => {
    const dir = makeRunTemp(prefix);
    made.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of made.splice(0)) removeRunTemp(dir);
});

describe('checkDiskFloor', () => {
    it('passes above the floor and stops below it, naming the numbers', () => {
        const free = freeGb(os.tmpdir());
        expect(checkDiskFloor(os.tmpdir(), 0)).toBeCloseTo(free, 0);
        expect(() => checkDiskFloor(os.tmpdir(), free + 1000)).toThrow(/GB is free .* needs \d+(\.\d+)? GB \(PERF_DISK_MIN_GB\)/);
        expect(() => checkDiskFloor(os.tmpdir(), Number.NaN)).toThrow('PERF_DISK_MIN_GB is a number of GB');
    });
});

describe('a run temp folder', () => {
    it('is removed in place, read-only parts included, and a second removal is fine', () => {
        const dir = temp('run-files-test-');
        const served = path.join(dir, 'served', 'deep');
        fs.mkdirSync(served, { recursive: true });
        fs.writeFileSync(path.join(served, 'file'), 'x');
        makeReadOnly(path.join(dir, 'served'));
        expect(isReadOnly(path.join(dir, 'served'))).toBe(true);
        expect(() => fs.writeFileSync(path.join(served, 'other'), 'y')).toThrow(/EACCES|EPERM/);
        removeRunTemp(dir);
        expect(fs.existsSync(dir)).toBe(false);
        expect(() => removeRunTemp(dir)).not.toThrow();
    });

    it("refuses anything it did not make: a folder outside the temp folder, or one not named as a run's", () => {
        expect(() => removeRunTemp(os.homedir())).toThrow("Not a run's temp folder");
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-run-'));
        try {
            expect(() => removeRunTemp(other)).toThrow("Not a run's temp folder");
            expect(fs.existsSync(other)).toBe(true);
        } finally {
            fs.rmdirSync(other);
        }
        expect(() => makeRunTemp('Bad prefix')).toThrow('lowercase');
    });
});
