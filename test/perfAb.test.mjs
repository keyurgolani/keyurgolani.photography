// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyse, compareMetric, loopbackListeners, median, MIN_ROUNDS, NOISE_FACTOR, noiseFloor, parseRounds, roundOrder, summarize, summaryMarkdown } from '../ci/perf/stats.mjs';

describe('median and summarize', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('refuses an empty list or a value that is not a finite number', () => {
    expect(() => median([])).toThrow(/no values/);
    expect(() => median([1, null])).toThrow(/finite/);
    expect(() => median([1, Infinity])).toThrow(/finite/);
  });

  it('gives the median with its min-max spread and count', () => {
    expect(summarize([120, 100, 110, 140, 105])).toEqual({ median: 110, min: 100, max: 140, n: 5 });
  });
});

describe('parseRounds', () => {
  it(`accepts whole numbers of ${MIN_ROUNDS} or more`, () => {
    expect(MIN_ROUNDS).toBe(5);
    expect(parseRounds('5')).toBe(5);
    expect(parseRounds(12)).toBe(12);
  });

  it('refuses fewer than five, fractions and junk', () => {
    for (const value of ['4', '0', '-5', '5.5', 'five', '', undefined]) expect(() => parseRounds(value)).toThrow(/at least 5/);
  });
});

describe('roundOrder', () => {
  it('runs the head between the two base servers, and flips the base pair each round', () => {
    expect(roundOrder(0)).toEqual(['A1', 'B', 'A2']);
    expect(roundOrder(1)).toEqual(['A2', 'B', 'A1']);
    expect(roundOrder(2)).toEqual(['A1', 'B', 'A2']);
  });

  it('alternates which of base and head goes first every round', () => {
    const firsts = [0, 1, 2, 3].map((round) => {
      const order = roundOrder(round);
      return order.indexOf('A1') < order.indexOf('B') ? 'base' : 'head';
    });
    expect(firsts).toEqual(['base', 'head', 'base', 'head']);
  });
});

describe('noiseFloor', () => {
  it(`is ${NOISE_FACTOR} times the largest per-round gap between the two base servers`, () => {
    expect(NOISE_FACTOR).toBe(1.5);
    // Gaps 10, 30, 0, 20, 5: the largest is 30.
    expect(noiseFloor([100, 130, 100, 90, 105], [110, 100, 100, 110, 100])).toBe(45);
  });

  it('is 0 when the base agrees with itself every round', () => {
    expect(noiseFloor([0, 0, 0, 0, 0], [0, 0, 0, 0, 0])).toBe(0);
  });

  it('refuses rounds that do not pair up', () => {
    expect(() => noiseFloor([1, 2], [1])).toThrow(/pair/);
    expect(() => noiseFloor([], [])).toThrow(/pair/);
  });
});

describe('compareMetric', () => {
  const a1 = [1000, 1020, 990, 1010, 1000];
  const a2 = [1010, 1000, 1000, 1000, 1020];
  // Largest A/A gap is 20, so the floor is 30. Base median 1000.

  it('flags a regression only past the floor', () => {
    const over = compareMetric({ a1, a2, b: [1040, 1031, 1035, 1050, 1029] });
    expect(over).toMatchObject({ floor: 30, delta: 35, verdict: 'regression' });
    expect(over.base).toEqual({ median: 1000, min: 990, max: 1020, n: 5 });
    expect(over.head).toEqual({ median: 1035, min: 1029, max: 1050, n: 5 });
  });

  it('calls a change at or inside the floor noise, and one past it on the fast side faster', () => {
    expect(compareMetric({ a1, a2, b: [1030, 1030, 1030, 1030, 1030] })).toMatchObject({ delta: 30, verdict: 'within noise' });
    expect(compareMetric({ a1, a2, b: [970, 960, 965, 990, 940] })).toMatchObject({ delta: -35, verdict: 'faster' });
  });

  it('flags any rise on a metric the base never moves on, since its floor is 0', () => {
    const zeros = [0, 0, 0, 0, 0];
    expect(compareMetric({ a1: zeros, a2: zeros, b: [0, 0, 12, 20, 16] })).toMatchObject({ floor: 0, delta: 12, verdict: 'regression' });
    expect(compareMetric({ a1: zeros, a2: zeros, b: zeros })).toMatchObject({ verdict: 'within noise' });
  });
});

/** A raw record as ab.mjs writes it: per round, per server, per profile, the loads. */
function rawWith(perServer) {
  const rounds = perServer.A1.length;
  return {
    meta: { base: { ref: 'v1.7.0', sha: 'aaa' }, head: { ref: 'next', sha: 'bbb' }, rounds, loads: 1, browser: 'Chrome 150' },
    fixtures: {
      one: {
        rounds: Array.from({ length: rounds }, (_, round) => ({
          round,
          order: roundOrder(round),
          servers: Object.fromEntries(['A1', 'A2', 'B'].map((server) => [server, { phone: [{ lcp: perServer[server][round], tbt: 0 }], desktop: [{ lcp: 500, tbt: 0 }] }])),
        })),
      },
    },
  };
}

describe('analyse and summaryMarkdown', () => {
  it('compares every fixture, profile and metric on the per-round medians of the loads', () => {
    const raw = rawWith({ A1: [1000, 1000, 1000, 1000, 1000], A2: [1010, 1000, 990, 1000, 1000], B: [1200, 1200, 1200, 1200, 1200] });
    const { rows, regressions } = analyse(raw);
    expect(rows.map((row) => row.metric)).toEqual(['one phone lcp', 'one phone tbt', 'one desktop lcp', 'one desktop tbt']);
    expect(regressions.map((row) => row.metric)).toEqual(['one phone lcp']);
    expect(rows[0]).toMatchObject({ floor: 15, delta: 200, verdict: 'regression' });
  });

  it('takes the median of the loads within a round before comparing rounds', () => {
    const raw = rawWith({ A1: [0, 0, 0, 0, 0], A2: [0, 0, 0, 0, 0], B: [0, 0, 0, 0, 0] });
    for (const round of raw.fixtures.one.rounds) round.servers.B.phone = [{ lcp: 100, tbt: 0 }, { lcp: 900, tbt: 0 }, { lcp: 120, tbt: 0 }];
    expect(analyse(raw).rows[0].head.median).toBe(120);
  });

  it('refuses a round that is missing a server', () => {
    const raw = rawWith({ A1: [1, 1, 1, 1, 1], A2: [1, 1, 1, 1, 1], B: [1, 1, 1, 1, 1] });
    delete raw.fixtures.one.rounds[2].servers.A2;
    expect(() => analyse(raw)).toThrow(/round 3.*A2/);
  });

  it('writes a table with both medians and spreads, the floor, and the rule it used', () => {
    const raw = rawWith({ A1: [1000, 1000, 1000, 1000, 1000], A2: [1010, 1000, 990, 1000, 1000], B: [1200, 1190, 1210, 1200, 1200] });
    const markdown = summaryMarkdown(raw, analyse(raw));
    expect(markdown).toContain('| one phone lcp | 1000 (1000–1000) | 1200 (1190–1210) | +200 | 15 | **regression** |');
    expect(markdown).toContain('1.5 × the largest per-round |A1 − A2|');
    expect(markdown).toContain('v1.7.0');
    expect(markdown).toMatch(/1 regression/);
  });
});

describe('loopbackListeners', () => {
  it('passes when every listener on the port is 127.0.0.1', () => {
    expect(loopbackListeners('LISTEN 0      511        127.0.0.1:3871       0.0.0.0:*\n', 3871)).toEqual({ ok: true, addresses: ['127.0.0.1:3871'] });
  });

  it('fails on a wildcard or another address, and on no listener at all', () => {
    expect(loopbackListeners('LISTEN 0 511 0.0.0.0:3871 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:3871 0.0.0.0:*\n', 3871).ok).toBe(false);
    expect(loopbackListeners('LISTEN 0 511 [::]:3871 [::]:*\n', 3871).ok).toBe(false);
    expect(loopbackListeners('', 3871).ok).toBe(false);
  });

  it('ignores listeners on other ports', () => {
    expect(loopbackListeners('LISTEN 0 511 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:3871 0.0.0.0:*\n', 3871)).toEqual({ ok: true, addresses: ['127.0.0.1:3871'] });
  });
});
