// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../test/helpers/runTsx';

/**
 * A6's review (7a): the watcher exits to re-bind a share that went
 * unreadable or empty, and relies on Docker starting it again, so
 * ci/check-compose.sh pins `restart: always` on image-watcher with
 * ci/compose-restart.jq, which these run against fixtures and the real file.
 */

const FILTER = path.join(REPO_ROOT, 'ci', 'compose-restart.jq');
const hasJq = spawnSync('jq', ['--version']).status === 0;

function passes(config: unknown): boolean {
    const run = spawnSync('jq', ['-e', '-f', FILTER], { input: JSON.stringify(config) });
    return run.status === 0;
}

describe.skipIf(!hasJq)('the compose check on image-watcher\'s restart policy', () => {
    it('passes restart: always and fails anything else, or none', () => {
        expect(passes({ services: { 'image-watcher': { restart: 'always' } } })).toBe(true);
        expect(passes({ services: { 'image-watcher': { restart: 'unless-stopped' } } })).toBe(false);
        expect(passes({ services: { 'image-watcher': {} } })).toBe(false);
        expect(passes({ services: {} })).toBe(false);
    });

    it('passes docker-compose.prod.yml as it is', () => {
        expect(passes(parse(fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8')))).toBe(true);
    });

    it('is a step of ci/check-compose.sh', () => {
        expect(fs.readFileSync(path.join(REPO_ROOT, 'ci', 'check-compose.sh'), 'utf8')).toMatch(/jq -e -f ci\/compose-restart\.jq <<<"\$resolved"/);
    });
});
