// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  analyse,
  compareMetric,
  INFO_METRICS,
  informational,
  loopbackListeners,
  MAX_ROUNDS,
  median,
  MIN_ROUNDS,
  MINIMUM_FLOOR_MS,
  MINIMUM_FLOOR_SHARE,
  minimumFloor,
  NOISE_FACTOR,
  noiseFloor,
  parseRounds,
  reduceLoad,
  roundOrder,
  summarize,
  summaryMarkdown,
  treeFor,
} from '../ci/perf/stats.mjs';

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
  it(`accepts whole numbers from ${MIN_ROUNDS} to ${MAX_ROUNDS}`, () => {
    expect([MIN_ROUNDS, MAX_ROUNDS]).toEqual([5, 20]);
    expect(parseRounds('5')).toBe(5);
    expect(parseRounds(12)).toBe(12);
    expect(parseRounds('20')).toBe(20);
  });

  it('refuses fewer than five, more than twenty, fractions and junk', () => {
    for (const value of ['4', '0', '-5', '5.5', 5.5, '21', 21, 'five', '', undefined]) expect(() => parseRounds(value)).toThrow(/from 5 to 20/);
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

describe('treeFor', () => {
  const trees = { base: '/w/base', head: '/w/head' };

  it('serves A1 and A2 from the base and B from the head', () => {
    expect(['A1', 'A2', 'B'].map((server) => treeFor(server, trees))).toEqual(['/w/base', '/w/base', '/w/head']);
  });

  it('refuses a server it does not know', () => {
    expect(() => treeFor('C', trees)).toThrow(/C/);
  });
});

describe('noiseFloor', () => {
  it(`is ${NOISE_FACTOR} times the median per-round gap between the two base servers`, () => {
    expect(NOISE_FACTOR).toBe(4);
    // Gaps 10, 30, 0, 20, 5: the median is 10.
    expect(noiseFloor([100, 130, 100, 90, 105], [110, 100, 100, 110, 100])).toBe(40);
  });

  it('counts a gap either way round, A2 over A1 as much as A1 over A2', () => {
    // A1 - A2 is -30, 40, -40, 50, 0: the gaps are 30, 40, 40, 50, 0, median 40. Signed, the median would be 0.
    expect(noiseFloor([100, 140, 100, 150, 100], [130, 100, 140, 100, 100])).toBe(160);
  });

  it('does not grow when rounds with the same noise are added', () => {
    const a2At = (gaps) => gaps.map((gap) => 1000 + gap);
    const five = [10, 20, 30, 10, 20];
    // The same gaps four times over, one of them a rarer large one, as 20 rounds will draw.
    const twenty = [...five, ...five, ...five, 10, 20, 120, 10, 20];
    expect(noiseFloor(five.map(() => 1000), a2At(five))).toBe(80);
    expect(noiseFloor(twenty.map(() => 1000), a2At(twenty))).toBe(80);
  });

  it('is 0 when the base agrees with itself every round', () => {
    expect(noiseFloor([0, 0, 0, 0, 0], [0, 0, 0, 0, 0])).toBe(0);
  });

  it('refuses rounds that do not pair up', () => {
    expect(() => noiseFloor([1, 2], [1])).toThrow(/pair/);
    expect(() => noiseFloor([], [])).toThrow(/pair/);
  });
});

describe('minimumFloor', () => {
  it('is 50 ms for LCP, 20 ms for TBT, and 5% of the base median for any other timing', () => {
    expect(MINIMUM_FLOOR_MS).toEqual({ lcp: 50, tbt: 20 });
    expect(MINIMUM_FLOOR_SHARE).toBe(0.05);
    expect(minimumFloor('lcp', 2400)).toBe(50);
    expect(minimumFloor('tbt', 0)).toBe(20);
    expect(minimumFloor('fcp', 1000)).toBe(50);
    expect(minimumFloor('load', 3000)).toBe(150);
  });
});

describe('compareMetric', () => {
  const a1 = [1000, 1080, 960, 1040, 1000];
  const a2 = [1040, 1000, 1000, 1000, 1080];
  // Each round's base is (A1 + A2) / 2: 1020, 1040, 980, 1020, 1040, median 1020. The gaps are 40, 80, 40, 40, 80,
  // median 40, so 4x is 160, past LCP's 50 ms minimum.

  it('uses 4x the median A/A gap when that is past the minimum, and flags a regression only past it', () => {
    const over = compareMetric({ metric: 'lcp', a1, a2, b: [1190, 1185, 1181, 1210, 1200] });
    expect(over).toMatchObject({ floor: 160, floorSource: 'A/A', delta: 170, verdict: 'regression' });
    expect(over.base).toEqual({ median: 1020, min: 980, max: 1040, n: 5 });
    expect(over.head).toEqual({ median: 1190, min: 1181, max: 1210, n: 5 });
    expect(over.a1).toEqual({ median: 1000, min: 960, max: 1080, n: 5 });
    expect(over.a2).toEqual({ median: 1000, min: 1000, max: 1080, n: 5 });
  });

  it('calls a change at or inside the floor noise, and one past it on the fast side faster', () => {
    expect(compareMetric({ metric: 'lcp', a1, a2, b: [1180, 1180, 1180, 1180, 1180] })).toMatchObject({ delta: 160, verdict: 'within noise' });
    expect(compareMetric({ metric: 'lcp', a1, a2, b: [850, 840, 845, 870, 820] })).toMatchObject({ delta: -175, verdict: 'faster' });
  });

  it('takes the base as the mean of A1 and A2 each round, so it brackets the head', () => {
    // A1 always 1000, A2 always 1040: floor 160. Against A1 alone the head would be +180, a regression.
    const five = (value) => [value, value, value, value, value];
    expect(compareMetric({ metric: 'lcp', a1: five(1000), a2: five(1040), b: five(1180) })).toMatchObject({ floor: 160, delta: 160, verdict: 'within noise' });
  });

  it('uses the minimum when the base never moves against itself', () => {
    const zeros = [0, 0, 0, 0, 0];
    // One stray long-task tick is noise, not a regression.
    expect(compareMetric({ metric: 'tbt', a1: zeros, a2: zeros, b: [0, 0, 12, 20, 16] })).toMatchObject({ floor: 20, floorSource: 'minimum', delta: 12, verdict: 'within noise' });
    expect(compareMetric({ metric: 'tbt', a1: zeros, a2: zeros, b: [25, 30, 22, 40, 28] })).toMatchObject({ floor: 20, floorSource: 'minimum', delta: 28, verdict: 'regression' });
    const flat = [1000, 1000, 1000, 1000, 1000];
    expect(compareMetric({ metric: 'lcp', a1: flat, a2: flat, b: [1040, 1040, 1040, 1040, 1040] })).toMatchObject({ floor: 50, floorSource: 'minimum', verdict: 'within noise' });
    expect(compareMetric({ metric: 'fcp', a1: flat, a2: flat, b: [1060, 1060, 1060, 1060, 1060] })).toMatchObject({ floor: 50, floorSource: 'minimum', verdict: 'regression' });
  });
});

describe('reduceLoad', () => {
  const lcp = [
    { t: 800, el: 'img', url: '/a' },
    { t: 1500.4, el: 'img[alt=Fixture] (portrait)', url: '/media/b' },
  ];
  // FCP at 300 and load at 2000, so long tasks count from 300 to 7000.
  const longtasks = [
    { t: 100, d: 200 }, // before FCP: out
    { t: 400, d: 120 }, // 70 past 50 ms
    { t: 2000, d: 50 }, // 0
    { t: 2500, d: 80.6 }, // 30.6
    { t: 7200, d: 300 }, // past load + 5 s: out
  ];

  it('sums each long task past 50 ms from FCP to load + 5 s, and takes the last LCP entry', () => {
    expect(reduceLoad({ lcp, longtasks, fcp: 300 }, 2000, 5000)).toEqual({ lcp: 1500, tbt: 101, fcp: 300, load: 2000, longtasks: 5, lcpElement: 'img[alt=Fixture] (portrait)', lcpUrl: '/media/b', bytes: null, toneFetchAfterLcp: null, toneFetchBytes: null });
  });

  it("carries the bytes transferred, and when the tone's sampler fetch started against LCP and what it transferred", () => {
    expect(reduceLoad({ lcp, longtasks, fcp: 300, bytes: 812_345, toneFetch: 2100.6, toneFetchBytes: 0 }, 2000, 5000)).toMatchObject({ bytes: 812_345, toneFetchAfterLcp: 600, toneFetchBytes: 0 });
    // A fetch before LCP reads as negative.
    expect(reduceLoad({ lcp, longtasks, fcp: 300, bytes: 1, toneFetch: 1000 }, 2000, 5000)).toMatchObject({ toneFetchAfterLcp: -500 });
    // No sampler fetch, or no LCP to time it against.
    expect(reduceLoad({ lcp, longtasks, fcp: 300, bytes: 1, toneFetch: null }, 2000, 5000)).toMatchObject({ toneFetchAfterLcp: null });
    expect(reduceLoad({ lcp: [], longtasks, fcp: 300, bytes: 1, toneFetch: 900 }, 2000, 5000)).toMatchObject({ toneFetchAfterLcp: null });
  });

  it('gives no LCP when the page reported none, and counts from 0 with no FCP', () => {
    expect(reduceLoad({ lcp: [], longtasks: [{ t: 10, d: 70 }], fcp: null }, 1000, 5000)).toEqual({ lcp: null, tbt: 20, fcp: 0, load: 1000, longtasks: 1, lcpElement: null, lcpUrl: null, bytes: null, toneFetchAfterLcp: null, toneFetchBytes: null });
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
    // The median A/A gap is 0, so LCP's 50 ms minimum sets the floor.
    expect(rows[0]).toMatchObject({ floor: 50, floorSource: 'minimum', delta: 200, verdict: 'regression' });
  });

  it('leaves a faster head out of the regressions', () => {
    const raw = rawWith({ A1: [1000, 1000, 1000, 1000, 1000], A2: [1000, 1000, 1000, 1000, 1000], B: [700, 700, 700, 700, 700] });
    const { rows, regressions } = analyse(raw);
    expect(rows[0]).toMatchObject({ delta: -300, verdict: 'faster' });
    expect(regressions).toEqual([]);
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
    expect(markdown).toContain('| Metric (ms) | Base (A1+A2)/2 | Head B | Head − base | Noise floor | Verdict |');
    expect(markdown).toContain('| one phone lcp | 1000 (995–1005) | 1200 (1190–1210) | +200 | 50 ms (minimum) | **regression** |');
    expect(markdown).toContain('at least 50 ms for LCP, 20 ms for TBT, and 5% of the base median for any other timing');
    expect(markdown).toContain('4 × the median per-round |A1 − A2|');
    expect(markdown).toContain('v1.7.0');
    expect(markdown).toMatch(/1 regression/);
  });

  it('shows A1 and A2 apart in the A/A table', () => {
    const raw = rawWith({ A1: [1000, 1000, 1000, 1000, 1000], A2: [1010, 1000, 990, 1000, 1000], B: [1200, 1190, 1210, 1200, 1200] });
    const markdown = summaryMarkdown(raw, analyse(raw));
    expect(markdown).toContain('| Metric (ms) | A1 | A2 | Median gap | Floor |');
    expect(markdown).toContain('| one phone lcp | 1000 (1000–1000) | 1000 (990–1010) | 0 | 50 ms (minimum) |');
  });
});

describe('informational and its table', () => {
  /** Five rounds where each server's phone loads carry `bytes` and `toneFetchAfterLcp` from `values`. */
  function rawWithInfo(values) {
    const raw = rawWith({ A1: [1000, 1000, 1000, 1000, 1000], A2: [1000, 1000, 1000, 1000, 1000], B: [1000, 1000, 1000, 1000, 1000] });
    for (const round of raw.fixtures.one.rounds) {
      for (const server of ['A1', 'A2', 'B']) round.servers[server].phone = values[server].map(([bytes, toneFetchAfterLcp, toneFetchBytes = null]) => ({ lcp: 1000, tbt: 0, bytes, toneFetchAfterLcp, toneFetchBytes }));
    }
    return raw;
  }

  it('reports bytes and the tone fetch per fixture and profile, base and head, from the per-round medians, and gates on neither', () => {
    expect(INFO_METRICS).toEqual(['bytes', 'toneFetchAfterLcp', 'toneFetchBytes']);
    const raw = rawWithInfo({ A1: [[800_000, null], [800_200, null]], A2: [[800_400, null], [800_600, null]], B: [[803_000, 1200, 0], [803_400, 1400, 0]] });
    const rows = informational(raw);
    expect(rows.map((row) => row.metric)).toEqual(['one phone bytes', 'one phone toneFetchAfterLcp', 'one phone toneFetchBytes', 'one desktop bytes', 'one desktop toneFetchAfterLcp', 'one desktop toneFetchBytes']);
    // Each round's base is the mean of A1's median, 800,100, and A2's, 800,500.
    expect(rows[0]).toMatchObject({ base: { median: 800_300 }, head: { median: 803_200 }, delta: 2900, baseLoads: { with: 20, of: 20 }, headLoads: { with: 10, of: 10 } });
    // The base never fetched for the tone; the head did in every load.
    expect(rows[1]).toMatchObject({ base: null, head: { median: 1300 }, delta: null, baseLoads: { with: 0, of: 20 }, headLoads: { with: 10, of: 10 } });
    // A cache hit on the head reads 0, which counts as a value.
    expect(rows[2]).toMatchObject({ base: null, head: { median: 0 }, headLoads: { with: 10, of: 10 } });
    // The desktop loads in rawWith() record none of them.
    expect(rows[3]).toMatchObject({ base: null, head: null, baseLoads: { with: 0, of: 10 } });
    expect(analyse(raw).rows.map((row) => row.metric)).toEqual(['one phone lcp', 'one phone tbt', 'one desktop lcp', 'one desktop tbt']);
  });

  it('prints them in a table of their own, marked as not gated', () => {
    const raw = rawWithInfo({ A1: [[800_000, null]], A2: [[800_400, null]], B: [[803_000, 1250, 0]] });
    const markdown = summaryMarkdown(raw, analyse(raw));
    expect(markdown).toContain('### Bytes and the tone fetch (for reference, not gated)');
    expect(markdown).toContain('| one phone bytes transferred (B) | 800200 (800200–800200) | 803000 (803000–803000) | +2800 | 10/10, 5/5 |');
    expect(markdown).toContain('| one phone tone fetch − LCP (ms) | none | 1250 (1250–1250) | n/a | 0/10, 5/5 |');
    expect(markdown).toContain('| one phone tone fetch transferred (B) | none | 0 (0–0) | n/a | 0/10, 5/5 |');
    expect(markdown).toMatch(/No regressions past the noise floor\./);
  });

  it('prints the one cache-on phone load of the head per fixture, beside the cache-off table, and gates on it never', () => {
    const raw = rawWithInfo({ A1: [[800_000, null]], A2: [[800_400, null]], B: [[803_000, 1250, 520]] });
    raw.fixtures.one.cacheOn = { lcp: 1000, tbt: 400, toneFetchAfterLcp: 900, toneFetchBytes: 0 };
    const markdown = summaryMarkdown(raw, analyse(raw));
    expect(markdown).toContain('### The tone fetch with the cache on (one phone load of the head, not gated)');
    expect(markdown).toContain('| one | 0 | 900 |');
    expect(analyse(raw).regressions).toEqual([]);
  });

  it('shows none for a cache-on load that made no tone fetch, and leaves the table out when no fixture has one', () => {
    const raw = rawWithInfo({ A1: [[800_000, null]], A2: [[800_400, null]], B: [[803_000, 1250, 520]] });
    expect(summaryMarkdown(raw, analyse(raw))).not.toContain('with the cache on');
    raw.fixtures.one.cacheOn = { lcp: 1000, tbt: 0, toneFetchAfterLcp: null, toneFetchBytes: null };
    expect(summaryMarkdown(raw, analyse(raw))).toContain('| one | none | none |');
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
