// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const THIS_FILE = 'components/motion/__tests__/sources.test.ts';

/** Tracked files that contain `text`, from `git grep -l`. An empty list when nothing matches. */
function filesContaining(text: string, ...pathspecs: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-F', text, '--', ...pathspecs], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Script sources, outside the tests and their helpers. */
const SCRIPTS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', ':!e2e', ':!test', ':!*__tests__*'];

describe('motion sources', () => {
  it('reads prefers-reduced-motion in script only through usePrefersReducedMotion', () => {
    expect(filesContaining('prefers-reduced-motion', ...SCRIPTS)).toEqual(['components/motion/usePrefersReducedMotion.ts']);
  });

  it('leaves NEXT_PUBLIC_CAROUSEL_INTERVAL nowhere', () => {
    expect(filesContaining('NEXT_PUBLIC_CAROUSEL_INTERVAL', `:!${THIS_FILE}`)).toEqual([]);
  });
});
