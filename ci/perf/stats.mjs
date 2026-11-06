// @ts-check
/**
 * The A/B perf job's arithmetic (.github/workflows/perf-ab.yml): medians, spreads, the noise floor from the base
 * measured against itself, the verdicts, and the job summary. Pure, so test/perfAb.test.mjs covers all of it; ab.mjs
 * measures and report.mjs prints.
 *
 * Three servers run in every round: A1 and A2 on the same base build, B on the head. A round's value for a server is
 * the median of its loads in that round. Base is A1, head is B, and A2 exists only to say how far the base moves
 * against itself in the same job: a metric's noise floor is NOISE_FACTOR times the largest per-round |A1 - A2|. Head
 * regresses on a metric when median(B) - median(A1), over the rounds, is past that floor.
 */

/** The fewest rounds the job runs. Fewer, and one bad round decides a median. */
export const MIN_ROUNDS = 5;
/** The noise floor's margin over the largest A/A gap seen. */
export const NOISE_FACTOR = 1.5;
/** What each load records that the job compares, in ms. */
export const METRICS = /** @type {const} */ (['lcp', 'tbt']);
/** The three servers, by role. */
export const SERVERS = /** @type {const} */ (['A1', 'A2', 'B']);

/** @typedef {'A1' | 'A2' | 'B'} Server */
/** @typedef {{ median: number, min: number, max: number, n: number }} Summary */
/** @typedef {'regression' | 'faster' | 'within noise'} Verdict */
/** @typedef {{ base: Summary, head: Summary, aa: Summary, floor: number, delta: number, verdict: Verdict }} Comparison */
/** @typedef {Comparison & { metric: string }} Row */
/** @typedef {{ lcp: number | null, tbt: number | null } & Record<string, unknown>} Load */
/** @typedef {{ round: number, order: Server[], servers: Partial<Record<Server, Record<string, Load[]>>> }} Round */
/** @typedef {{ ref: string, sha: string }} Tree */
/** @typedef {{ name: string, gzip: number | null, raw: number | null, files: number | null }} RouteJs */
/**
 * @typedef {{
 *   meta: { base: Tree, head: Tree, rounds: number, loads: number, browser: string, runner?: string },
 *   fixtures: Record<string, { rounds: Round[] }>,
 *   firstLoadJs?: { base: RouteJs[], head: RouteJs[] },
 * }} Raw
 */

/** @param {readonly unknown[]} values */
function finite(values) {
  if (values.length === 0) throw new Error('A median of no values.');
  for (const value of values) if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Every value must be a finite number, got ${value}.`);
  return /** @type {number[]} */ ([...values]).sort((a, b) => a - b);
}

/** @param {readonly unknown[]} values */
export function median(values) {
  const sorted = finite(values);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {readonly unknown[]} values @returns {Summary} */
export function summarize(values) {
  const sorted = finite(values);
  return { median: median(sorted), min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
}

/** The `rounds` input as a whole number of at least MIN_ROUNDS. @param {unknown} value */
export function parseRounds(value) {
  const rounds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(rounds) || rounds < MIN_ROUNDS) throw new Error(`rounds must be a whole number, at least ${MIN_ROUNDS}, got ${JSON.stringify(value)}.`);
  return rounds;
}

/**
 * The servers' order in a round, from 0. The head runs between the two base servers, and the base pair flips each
 * round, so which of A1 and B goes first alternates every round, and so does A2's against B and A1's against A2.
 * @param {number} round @returns {Server[]}
 */
export function roundOrder(round) {
  return round % 2 === 0 ? ['A1', 'B', 'A2'] : ['A2', 'B', 'A1'];
}

/** NOISE_FACTOR times the largest per-round gap between the two base servers. @param {readonly number[]} a1 @param {readonly number[]} a2 */
export function noiseFloor(a1, a2, factor = NOISE_FACTOR) {
  if (a1.length === 0 || a1.length !== a2.length) throw new Error(`The A/A rounds don't pair up: ${a1.length} against ${a2.length}.`);
  return factor * Math.max(...a1.map((value, round) => Math.abs(value - a2[round])));
}

/**
 * One metric's per-round values for each server, compared.
 * @param {{ a1: readonly number[], a2: readonly number[], b: readonly number[] }} rounds @returns {Comparison}
 */
export function compareMetric({ a1, a2, b }) {
  const base = summarize(a1);
  const head = summarize(b);
  const floor = noiseFloor(a1, a2);
  const delta = head.median - base.median;
  /** @type {Verdict} */
  const verdict = delta > floor ? 'regression' : -delta > floor ? 'faster' : 'within noise';
  return { base, head, aa: summarize(a2), floor, delta, verdict };
}

/**
 * Every fixture, profile and metric in `raw`, compared on the per-round medians of the loads.
 * @param {Raw} raw @returns {{ rows: Row[], regressions: Row[] }}
 */
export function analyse(raw) {
  /** @type {Row[]} */
  const rows = [];
  for (const [fixture, { rounds }] of Object.entries(raw.fixtures)) {
    if (rounds.length === 0) throw new Error(`Fixture ${fixture} has no rounds.`);
    const profiles = Object.keys(rounds[0].servers.A1 ?? {});
    for (const profile of profiles) {
      for (const metric of METRICS) {
        /** @type {Record<Server, number[]>} */
        const series = { A1: [], A2: [], B: [] };
        rounds.forEach((round, index) => {
          for (const server of SERVERS) {
            const loads = round.servers[server]?.[profile];
            if (!loads || loads.length === 0) throw new Error(`Fixture ${fixture}, round ${index + 1} has no ${server} measurements for ${profile}.`);
            try {
              series[server].push(median(loads.map((load) => load[metric])));
            } catch (error) {
              throw new Error(`Fixture ${fixture}, round ${index + 1}, ${server} ${profile} ${metric}: ${error instanceof Error ? error.message : error}`);
            }
          }
        });
        rows.push({ metric: `${fixture} ${profile} ${metric}`, ...compareMetric({ a1: series.A1, a2: series.A2, b: series.B }) });
      }
    }
  }
  return { rows, regressions: rows.filter((row) => row.verdict === 'regression') };
}

/** @param {number} value */
const ms = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
/** @param {Summary} summary */
const spread = (summary) => `${ms(summary.median)} (${ms(summary.min)}–${ms(summary.max)})`;
/** @param {Tree} tree */
const named = (tree) => `\`${tree.ref}\` (${tree.sha.slice(0, 12)})`;

/** The job summary: the setup, the rule, the table, and first-load JS for reference. @param {Raw} raw @param {{ rows: Row[], regressions: Row[] }} analysis */
export function summaryMarkdown(raw, { rows, regressions }) {
  const { meta } = raw;
  const lines = [
    `## Perf A/B: head ${named(meta.head)} against base ${named(meta.base)}`,
    '',
    `${meta.rounds} rounds on fixtures ${Object.keys(raw.fixtures).map((name) => `\`${name}\``).join(' and ')}, ${meta.loads} cold loads of Home per server, profile and round, in ${meta.browser}${meta.runner ? ` on ${meta.runner}` : ''}. Three servers on 127.0.0.1: A1 and A2 on the base build, B on the head. Even rounds run A1, B, A2 and odd rounds A2, B, A1, so base and head swap who goes first every round.`,
    '',
    `**Rule.** A server's value in a round is the median of its loads there. Each cell is the median over the rounds, with the min–max of the round values. A metric's noise floor is ${NOISE_FACTOR} × the largest per-round |A1 − A2| in this run. Head − base past the floor is a **regression**, and fails the job; past it the other way is *faster*. Everything else is within noise.`,
    '',
    '| Metric (ms) | Base A1 | Head B | Head − base | Noise floor | Verdict |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.metric} | ${spread(row.base)} | ${spread(row.head)} | ${row.delta > 0 ? '+' : ''}${ms(row.delta)} | ${ms(row.floor)} | ${row.verdict === 'regression' ? '**regression**' : row.verdict === 'faster' ? '*faster*' : row.verdict} |`),
    '',
    regressions.length === 0 ? 'No regressions past the noise floor.' : `${regressions.length} regression${regressions.length === 1 ? '' : 's'} past the noise floor: ${regressions.map((row) => row.metric).join(', ')}.`,
    '',
    '<details><summary>The base against itself (A2)</summary>',
    '',
    '| Metric (ms) | A1 | A2 | Floor |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.metric} | ${spread(row.base)} | ${spread(row.aa)} | ${ms(row.floor)} |`),
    '',
    '</details>',
  ];
  const js = raw.firstLoadJs;
  if (js) {
    /** @param {RouteJs | undefined} route */
    const bytes = (route) => (route?.gzip == null ? 'n/a' : `${route.gzip} B (${route.files} files)`);
    lines.push(
      '',
      '### First-load JS, gzipped (for reference, not gated)',
      '',
      'Read from each build\'s manifests, so it has no run-to-run noise and no floor to gate on.',
      '',
      '| Route | Base | Head | Change |',
      '|---|---|---|---|',
      ...js.head.map((head) => {
        const base = js.base.find((route) => route.name === head.name);
        const change = base?.gzip != null && head.gzip != null ? `${head.gzip - base.gzip >= 0 ? '+' : ''}${head.gzip - base.gzip} B` : 'n/a';
        return `| ${head.name} | ${bytes(base)} | ${bytes(head)} | ${change} |`;
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Whether every listener `ss -Hltn` shows on `port` is 127.0.0.1, and at least one is.
 * @param {string} output @param {number} port
 */
export function loopbackListeners(output, port) {
  const addresses = output
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[3])
    .filter((local) => local !== undefined && local.endsWith(`:${port}`));
  return { ok: addresses.length > 0 && addresses.every((local) => local === `127.0.0.1:${port}`), addresses };
}
