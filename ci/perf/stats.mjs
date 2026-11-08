// @ts-check
/**
 * The A/B perf job's arithmetic (.github/workflows/perf-ab.yml): medians, spreads, the noise floor from the base
 * measured against itself, the verdicts, and the job summary. Pure, so test/perfAb.test.mjs covers all of it; ab.mjs
 * measures and report.mjs prints.
 *
 * Three servers run in every round: A1 and A2 on the same base build, B on the head. A round's value for a server is
 * the median of its loads in that round. B always runs between A1 and A2 (roundOrder()), so a round's base is
 * (A1 + A2) / 2, which brackets B whichever base server went first. A1 against A2 also says how far the base moves
 * against itself in the same job: a metric's noise floor is NOISE_FACTOR times the median per-round |A1 - A2|, or the
 * metric's minimum (minimumFloor()) when that's larger, so a base that never moves doesn't fail the job on one stray
 * millisecond. A median, not the largest gap, so the floor holds still as rounds are added instead of growing with
 * them. Head regresses on a metric when median(B) - median(base), over the rounds, is past that floor.
 */

/** The fewest rounds the job runs. Fewer, and one bad round decides a median. */
export const MIN_ROUNDS = 5;
/** The most, which the workflow's 200-minute ceiling covers. */
export const MAX_ROUNDS = 20;
/** The noise floor's multiple of the median A/A gap. */
export const NOISE_FACTOR = 4;
/** The least noise floor for LCP and TBT, in ms. */
export const MINIMUM_FLOOR_MS = /** @type {Readonly<Record<string, number>>} */ ({ lcp: 50, tbt: 20 });
/** The least noise floor for any other timing, as a share of the base median. */
export const MINIMUM_FLOOR_SHARE = 0.05;
/** What each load records that the job compares, in ms. */
export const METRICS = /** @type {const} */ (['lcp', 'tbt']);
/** What each load records for reference only: bytes transferred, and the tone sampler's fetch start against LCP and its bytes. */
export const INFO_METRICS = /** @type {const} */ (['bytes', 'toneFetchAfterLcp', 'toneFetchBytes']);
/** The INFO_METRICS that are Home's own: the Viewer has no copy-tone sampler, so its loads never have them. */
const HOME_ONLY_INFO = new Set(['toneFetchAfterLcp', 'toneFetchBytes']);
/**
 * The pages each load can be of, by name: Home, and the Viewer, loaded directly at its first series' first photograph
 * (ab.mjs). A round keeps each page's loads per profile under loadKey(): Home's under the profile's own name, as
 * before the Viewer was measured, so an older raw.json reads the same.
 */
export const PAGES = /** @type {const} */ ({ home: '', viewer: 'viewer ' });
/** The Viewer's loads' key prefix in a round. */
const VIEWER_PREFIX = PAGES.viewer;
/** Their labels in the job summary. */
const INFO_LABELS = /** @type {Readonly<Record<string, string>>} */ ({ bytes: 'bytes transferred (B)', toneFetchAfterLcp: 'tone fetch − LCP (ms)', toneFetchBytes: 'tone fetch transferred (B)' });
/** The three servers, by role. */
export const SERVERS = /** @type {const} */ (['A1', 'A2', 'B']);

/** @typedef {'A1' | 'A2' | 'B'} Server */
/** @typedef {{ median: number, min: number, max: number, n: number }} Summary */
/** @typedef {'regression' | 'faster' | 'within noise'} Verdict */
/**
 * @typedef {{
 *   base: Summary, head: Summary, a1: Summary, a2: Summary, medianGap: number,
 *   floor: number, floorSource: 'A/A' | 'minimum', delta: number, verdict: Verdict,
 * }} Comparison
 */
/** @typedef {Comparison & { metric: string }} Row */
/** @typedef {{ lcp: number | null, tbt: number | null } & Record<string, unknown>} Load */
/** @typedef {{ round: number, order: Server[], servers: Partial<Record<Server, Record<string, Load[]>>> }} Round */
/** @typedef {{ ref: string, sha: string }} Tree */
/** @typedef {{ name: string, gzip: number | null, raw: number | null, files: number | null }} RouteJs */
/**
 * @typedef {{
 *   meta: { base: Tree, head: Tree, rounds: number, loads: number, browser: string, runner?: string, viewer?: Record<string, string> },
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

/** The `rounds` input as a whole number from MIN_ROUNDS to MAX_ROUNDS. @param {unknown} value */
export function parseRounds(value) {
  const rounds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(rounds) || rounds < MIN_ROUNDS || rounds > MAX_ROUNDS) throw new Error(`rounds must be a whole number from ${MIN_ROUNDS} to ${MAX_ROUNDS}, got ${JSON.stringify(value)}.`);
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

/** The median per-round gap between the two base servers, either way round. @param {readonly number[]} a1 @param {readonly number[]} a2 */
export function medianGap(a1, a2) {
  if (a1.length === 0 || a1.length !== a2.length) throw new Error(`The A/A rounds don't pair up: ${a1.length} against ${a2.length}.`);
  return median(a1.map((value, round) => Math.abs(value - a2[round])));
}

/**
 * Where a round keeps `page`'s loads for `profile`: the profile's name for Home, `viewer <profile>` for the Viewer.
 * @param {string} page @param {string} profile
 */
export function loadKey(page, profile) {
  if (!Object.hasOwn(PAGES, page)) throw new Error(`No page ${page}.`);
  return `${PAGES[/** @type {keyof typeof PAGES} */ (page)]}${profile}`;
}

/** Every `href="..."` attribute's value in `html`, in order: links Next writes into its payload are escaped text, not attributes. @param {string} html */
const hrefs = (html) => [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1].replaceAll('&amp;', '&'));

/** The first series Work's HTML links to, as `/work/<slug>`, or null. @param {string} html */
export function seriesPathIn(html) {
  return hrefs(html).find((href) => /^\/work\/[^/?#]+$/.test(href)) ?? null;
}

/** The first photograph's Viewer that `series`' page links to, as `<series>/photo/<id>`, or null. @param {string} html @param {string} series */
export function viewerPathIn(html, series) {
  return hrefs(html).find((href) => href.startsWith(`${series}/photo/`) && /^[^/?#]+$/.test(href.slice(series.length + '/photo/'.length))) ?? null;
}

/**
 * The one path every server found, so base and head measure the same page; else an error naming what each found.
 * @param {Partial<Record<Server, string | null>>} found
 */
export function samePath(found) {
  const paths = SERVERS.map((server) => found[server] ?? null);
  if (paths[0] !== null && paths.every((path) => path === paths[0])) return paths[0];
  throw new Error(`The servers don't find the same Viewer page: ${SERVERS.map((server, index) => `${server} ${paths[index] ?? 'none'}`).join(', ')}.`);
}

/** NOISE_FACTOR times the median per-round gap between the two base servers. @param {readonly number[]} a1 @param {readonly number[]} a2 */
export function noiseFloor(a1, a2, factor = NOISE_FACTOR) {
  return factor * medianGap(a1, a2);
}

/**
 * Which tree a server runs: A1 and A2 the base, B the head.
 * @template T @param {string} server @param {{ base: T, head: T }} trees @returns {T}
 */
export function treeFor(server, { base, head }) {
  if (server === 'A1' || server === 'A2') return base;
  if (server === 'B') return head;
  throw new Error(`No server ${server}.`);
}

/**
 * @typedef {{
 *   lcp: { t: number, el: string | null, url: string }[], longtasks: { t: number, d: number }[], fcp: number | null,
 *   bytes?: number | null, toneFetch?: number | null, toneFetchBytes?: number | null,
 * }} PageEntries
 */

/**
 * One load's numbers from what the page observed (measure.mjs). LCP is the last `largest-contentful-paint` entry, or
 * null when there was none. TBT is the sum of each long task past 50 ms that starts from FCP (0 without one) to
 * `loadAt` + `settleMs`. For reference, not gated: `bytes`, what the load transferred; `toneFetchAfterLcp`, when
 * Home's copy-tone sampler started its fetch (measure.mjs) against LCP, negative before it; and `toneFetchBytes`, what
 * that fetch transferred, 0 from the cache. Null where there's none.
 * @param {PageEntries} entries @param {number} loadAt @param {number} settleMs
 */
export function reduceLoad({ lcp, longtasks, fcp, bytes = null, toneFetch = null, toneFetchBytes = null }, loadAt, settleMs) {
  const from = fcp ?? 0;
  const tbt = longtasks.filter((task) => task.t >= from && task.t <= loadAt + settleMs).reduce((sum, task) => sum + Math.max(0, task.d - 50), 0);
  const last = lcp.at(-1) ?? null;
  const toneFetchAfterLcp = last && typeof toneFetch === 'number' ? Math.round(toneFetch - last.t) : null;
  return { lcp: last ? Math.round(last.t) : null, tbt: Math.round(tbt), fcp: Math.round(from), load: loadAt, longtasks: longtasks.length, lcpElement: last?.el ?? null, lcpUrl: last?.url ?? null, bytes: typeof bytes === 'number' ? bytes : null, toneFetchAfterLcp, toneFetchBytes: typeof toneFetchBytes === 'number' ? toneFetchBytes : null };
}

/** A metric's least noise floor: MINIMUM_FLOOR_MS for LCP and TBT, else MINIMUM_FLOOR_SHARE of the base median. @param {string} metric @param {number} baseMedian */
export function minimumFloor(metric, baseMedian) {
  return MINIMUM_FLOOR_MS[metric] ?? MINIMUM_FLOOR_SHARE * baseMedian;
}

/**
 * One metric's per-round values for each server, compared. Each round's base is (A1 + A2) / 2. The floor is the
 * larger of NOISE_FACTOR times the median A/A gap and the metric's minimum.
 * @param {{ metric: string, a1: readonly number[], a2: readonly number[], b: readonly number[] }} rounds @returns {Comparison}
 */
export function compareMetric({ metric, a1, a2, b }) {
  const gap = medianGap(a1, a2);
  const base = summarize(a1.map((value, round) => (value + a2[round]) / 2));
  const head = summarize(b);
  const spread = NOISE_FACTOR * gap;
  const minimum = minimumFloor(metric, base.median);
  const floor = Math.max(spread, minimum);
  /** @type {Comparison['floorSource']} */
  const floorSource = minimum > spread ? 'minimum' : 'A/A';
  const delta = head.median - base.median;
  /** @type {Verdict} */
  const verdict = delta > floor ? 'regression' : -delta > floor ? 'faster' : 'within noise';
  return { base, head, a1: summarize(a1), a2: summarize(a2), medianGap: gap, floor, floorSource, delta, verdict };
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
        rows.push({ metric: `${fixture} ${profile} ${metric}`, ...compareMetric({ metric, a1: series.A1, a2: series.A2, b: series.B }) });
      }
    }
  }
  return { rows, regressions: rows.filter((row) => row.verdict === 'regression') };
}

/**
 * @typedef {{
 *   metric: string, base: Summary | null, head: Summary | null, delta: number | null,
 *   baseLoads: { with: number, of: number }, headLoads: { with: number, of: number },
 * }} InfoRow
 */

/**
 * INFO_METRICS for every fixture and profile in `raw`, base and head, by the same per-round medians as analyse(), with
 * no floor and no verdict. A load without the value (no sampler fetch, say) is left out, a round's base is the mean of
 * whichever of A1 and A2 has one, and a side with none in any round is null. Each side counts its loads with a value.
 * @param {Raw} raw @returns {InfoRow[]}
 */
export function informational(raw) {
  /** @type {InfoRow[]} */
  const rows = [];
  for (const [fixture, { rounds }] of Object.entries(raw.fixtures)) {
    if (rounds.length === 0) throw new Error(`Fixture ${fixture} has no rounds.`);
    for (const profile of Object.keys(rounds[0].servers.A1 ?? {})) {
      for (const metric of INFO_METRICS.filter((name) => !(profile.startsWith(VIEWER_PREFIX) && HOME_ONLY_INFO.has(name)))) {
        const baseLoads = { with: 0, of: 0 };
        const headLoads = { with: 0, of: 0 };
        /** @type {number[]} */
        const base = [];
        /** @type {number[]} */
        const head = [];
        for (const round of rounds) {
          /** @param {Server} server @param {{ with: number, of: number }} count */
          const value = (server, count) => {
            const loads = round.servers[server]?.[profile] ?? [];
            const values = loads.map((load) => load[metric]).filter((v) => typeof v === 'number' && Number.isFinite(v));
            count.with += values.length;
            count.of += loads.length;
            return values.length > 0 ? median(values) : null;
          };
          const pair = [value('A1', baseLoads), value('A2', baseLoads)].filter((v) => v !== null);
          if (pair.length > 0) base.push(pair.reduce((sum, v) => sum + v, 0) / pair.length);
          const b = value('B', headLoads);
          if (b !== null) head.push(b);
        }
        const baseSummary = base.length > 0 ? summarize(base) : null;
        const headSummary = head.length > 0 ? summarize(head) : null;
        rows.push({ metric: `${fixture} ${profile} ${metric}`, base: baseSummary, head: headSummary, delta: baseSummary && headSummary ? headSummary.median - baseSummary.median : null, baseLoads, headLoads });
      }
    }
  }
  return rows;
}

/** @param {number} value */
const ms = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
/** @param {Summary} summary */
const spread = (summary) => `${ms(summary.median)} (${ms(summary.min)}–${ms(summary.max)})`;
/** @param {Comparison} row */
const floorCell = (row) => `${ms(row.floor)} ms${row.floorSource === 'minimum' ? ' (minimum)' : ''}`;
/** @param {Tree} tree */
const named = (tree) => `\`${tree.ref}\` (${tree.sha.slice(0, 12)})`;

/**
 * Per fixture and server, how many loads recorded their requests off 127.0.0.1 (measure.mjs `offLoopback`), and how
 * many of those had one. A load without the record, from an older raw.json, isn't counted.
 * @param {Raw} raw
 */
export function offLoopbackCounts(raw) {
  /** @type {{ fixture: string, server: string, loads: number, stray: number }[]} */
  const rows = [];
  for (const [fixture, { rounds }] of Object.entries(raw.fixtures)) {
    for (const server of /** @type {Server[]} */ (['A1', 'A2', 'B'])) {
      let loads = 0;
      let stray = 0;
      for (const round of rounds) {
        for (const list of Object.values(round.servers[server] ?? {})) {
          for (const load of list) {
            if (!Array.isArray(load.offLoopback)) continue;
            loads++;
            if (load.offLoopback.length > 0) stray++;
          }
        }
      }
      if (loads > 0) rows.push({ fixture, server, loads, stray });
    }
  }
  return rows;
}

/**
 * Every recorded load that asked for something off 127.0.0.1 (measure.mjs `offLoopback`), as where and what.
 * @param {Raw} raw
 */
export function offLoopbackRequests(raw) {
  /** @type {{ where: string, urls: string[] }[]} */
  const found = [];
  for (const [fixture, { rounds }] of Object.entries(raw.fixtures)) {
    for (const round of rounds) {
      for (const [server, byProfile] of Object.entries(round.servers)) {
        for (const [profile, loads] of Object.entries(byProfile ?? {})) {
          loads.forEach((load, index) => {
            const urls = Array.isArray(load.offLoopback) ? load.offLoopback.filter((url) => typeof url === 'string') : [];
            if (urls.length > 0) found.push({ where: `${fixture} round ${round.round + 1} ${server} ${profile} load ${index + 1}`, urls });
          });
        }
      }
    }
  }
  return found;
}

/**
 * What the loads were of: Home on every fixture, and the Viewer on the fixtures whose rounds have its loads, with the
 * page each loaded (meta.viewer).
 * @param {Raw} raw
 */
function pagesLoaded(raw) {
  const viewer = Object.entries(raw.fixtures).filter(([, { rounds }]) => Object.keys(rounds[0]?.servers.A1 ?? {}).some((key) => key.startsWith(VIEWER_PREFIX)));
  if (viewer.length === 0) return 'Home';
  const where = viewer.map(([name]) => `\`${name}\`${raw.meta.viewer?.[name] ? ` of the Viewer, \`${raw.meta.viewer[name]}\` loaded directly` : ' of the Viewer'}`);
  return `Home, and on ${where.join(' and on ')}, the first photograph of the first series Work lists`;
}

/** The job summary: the setup, the rule, the table, and first-load JS for reference. @param {Raw} raw @param {{ rows: Row[], regressions: Row[] }} analysis */
export function summaryMarkdown(raw, { rows, regressions }) {
  const { meta } = raw;
  const lines = [
    `## Perf A/B: head ${named(meta.head)} against base ${named(meta.base)}`,
    '',
    `${meta.rounds} rounds on fixtures ${Object.keys(raw.fixtures).map((name) => `\`${name}\``).join(' and ')}, ${meta.loads} cold loads per server, profile and round of ${pagesLoaded(raw)}, in ${meta.browser}${meta.runner ? ` on ${meta.runner}` : ''}. Three servers on 127.0.0.1: A1 and A2 on the base build, B on the head. Even rounds run A1, B, A2 and odd rounds A2, B, A1, so base and head swap who goes first every round.`,
    '',
    `**Rule.** A server's value in a round is the median of its loads there, and the base's is (A1 + A2) / 2, which brackets B. Each cell is the median over the rounds, with the min–max of the round values. A metric's noise floor is ${NOISE_FACTOR} × the median per-round |A1 − A2| in this run, but at least ${MINIMUM_FLOOR_MS.lcp} ms for LCP, ${MINIMUM_FLOOR_MS.tbt} ms for TBT, and ${MINIMUM_FLOOR_SHARE * 100}% of the base median for any other timing; "(minimum)" marks a floor set by that. Head − base past the floor is a **regression**, and fails the job; past it the other way is *faster*. Everything else is within noise.`,
    '',
    '| Metric (ms) | Base (A1+A2)/2 | Head B | Head − base | Noise floor | Verdict |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.metric} | ${spread(row.base)} | ${spread(row.head)} | ${row.delta > 0 ? '+' : ''}${ms(row.delta)} | ${floorCell(row)} | ${row.verdict === 'regression' ? '**regression**' : row.verdict === 'faster' ? '*faster*' : row.verdict} |`),
    '',
    regressions.length === 0 ? 'No regressions past the noise floor.' : `${regressions.length} regression${regressions.length === 1 ? '' : 's'} past the noise floor: ${regressions.map((row) => row.metric).join(', ')}.`,
    '',
    '<details><summary>The base against itself (A1 and A2)</summary>',
    '',
    '| Metric (ms) | A1 | A2 | Median gap | Floor |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.metric} | ${spread(row.a1)} | ${spread(row.a2)} | ${ms(row.medianGap)} | ${floorCell(row)} |`),
    '',
    '</details>',
  ];
  const info = informational(raw);
  if (info.some((row) => row.base || row.head)) {
    /** @param {Summary | null} summary */
    const cell = (summary) => (summary ? spread(summary) : 'none');
    /** @param {string} metric */
    const label = (metric) => metric.replace(/(\S+)$/, (name) => INFO_LABELS[name] ?? name);
    lines.push(
      '',
      '### Bytes and the tone fetch (for reference, not gated)',
      '',
      'Bytes are each load\'s transferSize summed over the document and every resource. The tone fetch is Home\'s copy-tone sampler\'s one fetch() of /media: when it started, less the load\'s LCP, so positive is after LCP, and what it transferred, 0 from the cache. Every load is a first visit in a fresh context with the cache on, so that fetch reads 0 where the browser served it from the cache, and a fetch the cache refused (only-if-cached) counts as none. Same per-round medians as above, over the loads that have a value; the last column counts those loads, base then head. No floor, no verdict.',
      '',
      '| Metric | Base (A1+A2)/2 | Head B | Head − base | Loads with a value |',
      '|---|---|---|---|---|',
      ...info.map((row) => `| ${label(row.metric)} | ${cell(row.base)} | ${cell(row.head)} | ${row.delta === null ? 'n/a' : `${row.delta > 0 ? '+' : ''}${ms(row.delta)}`} | ${row.baseLoads.with}/${row.baseLoads.of}, ${row.headLoads.with}/${row.headLoads.of} |`),
    );
  }
  const checked = offLoopbackCounts(raw);
  if (checked.length > 0) {
    const stray = offLoopbackRequests(raw);
    lines.push(
      '',
      '### Requests off 127.0.0.1 (none is the pass; not gated)',
      '',
      'Every round load\'s requests, the page\'s, a service worker\'s and its WebSockets, base and head alike; the warm-up loads aren\'t counted. The browser resolves no hostname but 127.0.0.1, and each request off loopback is named below: a page that asks for something there isn\'t the page a visitor gets.',
      '',
      '| Fixture | Server | Round loads checked | Loads with a request off 127.0.0.1 |',
      '|---|---|---|---|',
      ...checked.map((row) => `| ${row.fixture} | ${row.server} | ${row.loads} | ${row.stray} |`),
    );
    if (stray.length > 0) {
      lines.push('', `**${stray.length} load${stray.length === 1 ? '' : 's'} asked for something off 127.0.0.1.**`, '', ...stray.map(({ where, urls }) => `- ${where}: ${urls.join(', ')}`));
    }
  }
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
