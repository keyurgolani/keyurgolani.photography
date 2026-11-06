#!/usr/bin/env node
// @ts-check
/**
 * The A/B perf job's verdict: reads ab.mjs's raw.json, prints the table (stats.mjs), appends it to
 * $GITHUB_STEP_SUMMARY when that's set, and exits 1 only when a metric regresses past its noise floor.
 *
 *   node ci/perf/report.mjs <raw.json>
 */
import fs from 'node:fs';
import { analyse, summaryMarkdown } from './stats.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node ci/perf/report.mjs <raw.json>');
  process.exit(2);
}
/** @type {import('./stats.mjs').Raw} */
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const analysis = analyse(raw);
const markdown = summaryMarkdown(raw, analysis);
process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
for (const row of analysis.regressions) console.error(`::error::${row.metric}: head ${row.head.median} ms against base ${row.base.median} ms, +${row.delta} past the ${row.floor} ms noise floor.`);
process.exitCode = analysis.regressions.length > 0 ? 1 : 0;
