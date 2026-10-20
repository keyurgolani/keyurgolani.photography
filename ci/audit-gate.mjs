// Production audit gate for the `audit` job in .github/workflows/ci.yml.
//
// It fails on a high or critical advisory in a production dependency unless
// .github/audit-allowlist.json lists it. Each allowlist entry looks like
//
//   { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name",
//     "reason": "Why the advisory doesn't reach this site.",
//     "expires": "YYYY-MM-DD" }
//
// `id` is the advisory's GHSA ID, or npm:<number> for an advisory without a
// GHSA URL. The entry covers that advisory in that package through its
// expires date (UTC), which is at most 90 days out. An entry is the last
// resort, for when no release of the package, or of the parent that pins it,
// fixes the advisory. Try an npm `overrides` pin first.
//
// Run directly, it runs `npm audit --omit=dev --json` and decides from the
// JSON alone, because npm audit exits 1 for any advisory, moderate and
// allowlisted ones included. A report it can't read, or one that doesn't
// match the version 2 format this script knows, fails the job.
//
//   --input <path>      read a saved report instead of running npm audit
//   --allowlist <path>  use this allowlist instead of .github/audit-allowlist.json
//
// It prints one line per finding, writes the same table to
// $GITHUB_STEP_SUMMARY when that's set, and exits 1 on any failure.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BLOCKING_SEVERITIES = ['critical', 'high'];
const KNOWN_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const REPORT_VERSION = 2;
const ENTRY_FIELDS = ['id', 'package', 'reason', 'expires'];
const MAX_ALLOWLIST_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const NPM_ID = /^npm:\d+$/;
// Only a plain https URL becomes a link in the step summary.
const SAFE_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/;
// npm gives up on a request after 2 minutes, and the script stops waiting for
// npm after 3, so a stalled registry fails inside the job's 5-minute timeout.
const NPM_FETCH_TIMEOUT_MS = 120_000;
const NPM_AUDIT_TIMEOUT_MS = 180_000;
const RERUN_HINT = 'If the registry was unreachable, rerun the job.';
const ALL_CLEAR = 'No high or critical advisory in production dependencies.';
const USAGE = 'Usage: node ci/audit-gate.mjs [--input <report.json>] [--allowlist <allowlist.json>]';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Text from the report or the allowlist, with control characters, line breaks
// included, turned into spaces, so it can't split a log line or a workflow
// command.
function clean(value) {
  return String(value).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
}

// Days since 1970-01-01 for a YYYY-MM-DD date, or null when it isn't a real
// calendar date.
function dayNumber(value) {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.getTime() / DAY_MS;
}

function dateFromDayNumber(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function joinList(items) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

// Allowlist IDs and package names match after trimming, and GHSA IDs match in
// any case.
function matchKey(id, pkg) {
  return `${id.trim().toLowerCase()} ${pkg.trim()}`;
}

function describeEntry(entry, index) {
  const field = (name) => (isObject(entry) && typeof entry[name] === 'string' ? clean(entry[name]).trim() : '');
  const label = [field('id'), field('package') && `in ${field('package')}`].filter(Boolean).join(' ');
  return `Allowlist entry ${index + 1}${label ? ` (${label})` : ''}`;
}

// Returns the entries that can cover a finding today, and a failure for every
// entry that can't.
function checkAllowlist(allowlist, today) {
  if (!Array.isArray(allowlist)) {
    return { entries: [], failures: ['The allowlist must be a JSON array of entries.'] };
  }
  const entries = [];
  const failures = [];
  allowlist.forEach((entry, index) => {
    const label = describeEntry(entry, index);
    if (!isObject(entry)) {
      failures.push(`${label} is not an object with ${ENTRY_FIELDS.join(', ')}.`);
      return;
    }
    const missing = ENTRY_FIELDS.filter((field) => typeof entry[field] !== 'string' || entry[field].trim() === '');
    if (missing.length > 0) {
      failures.push(`${label} has no ${missing.join(', ')}. Every entry needs ${ENTRY_FIELDS.join(', ')}.`);
      return;
    }
    const id = entry.id.trim();
    if (!GHSA_ID.test(id) && !NPM_ID.test(id)) {
      failures.push(`${label} has the id "${clean(id)}", which is neither a GHSA ID nor npm:<number>.`);
      return;
    }
    const expires = dayNumber(entry.expires);
    if (expires === null) {
      failures.push(`${label} expires "${clean(entry.expires)}", which is not a YYYY-MM-DD date.`);
    } else if (expires < today) {
      failures.push(
        `${label} expired on ${entry.expires}. Fix the advisory or renew the entry with a current reason, ` +
          'or delete the entry if it no longer matches anything.',
      );
    } else if (expires - today > MAX_ALLOWLIST_DAYS) {
      failures.push(
        `${label} expires ${entry.expires}, more than ${MAX_ALLOWLIST_DAYS} days out. ` +
          `Pick ${dateFromDayNumber(today + MAX_ALLOWLIST_DAYS)} or earlier.`,
      );
    } else {
      const advisory = `${clean(id)} in ${clean(entry.package).trim()}`;
      entries.push({ index, label, advisory, key: matchKey(id, entry.package), used: false });
    }
  });
  return { entries, failures };
}

// Two valid entries for the same advisory both count, but only one is needed.
function duplicateWarnings(entries) {
  const byKey = new Map();
  for (const entry of entries) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  return [...byKey.values()]
    .filter((group) => group.length > 1)
    .map(
      (group) =>
        `Allowlist entries ${joinList(group.map((entry) => entry.index + 1))} cover the same advisory, ` +
        `${group[0].advisory}. Keep the one that expires last.`,
    );
}

// The GHSA-xxxx-xxxx-xxxx at the end of the advisory URL, or npm:<source> for
// an advisory without one, so two such advisories never share an ID. An
// advisory with neither is "unknown", which no allowlist entry can match.
function advisoryId(via) {
  const segment = typeof via.url === 'string' ? via.url.trim().replace(/\/+$/, '').split('/').pop() : '';
  if (GHSA_ID.test(segment)) return segment;
  if (Number.isSafeInteger(via.source) && via.source >= 0) return `npm:${via.source}`;
  if (typeof via.source === 'string' && /^\d+$/.test(via.source)) return `npm:${via.source}`;
  return 'unknown';
}

// npm 11 puts what went wrong in the top-level message, and statusCode for an
// HTTP error, and leaves error.summary and error.detail empty when the
// advisory endpoint fails. Older failures, such as a missing lockfile, fill in
// error.code and error.summary instead.
function errorDetail(report) {
  const error = isObject(report.error) ? report.error : {};
  const parts = [error.code, error.summary, report.message]
    .filter((part) => typeof part === 'string')
    .map((part) => clean(part).trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  if (Number.isInteger(report.statusCode) && !unique.some((part) => part.includes(String(report.statusCode)))) {
    unique.unshift(`HTTP ${report.statusCode}`);
  }
  return unique.length > 0 ? unique.join(': ') : clean(JSON.stringify(report.error));
}

function severityText(severity) {
  return severity === undefined ? 'no severity' : `the severity ${clean(JSON.stringify(severity))}`;
}

// Returns the high and critical advisories in the report, one per advisory ID
// and package, and a failure for anything in the report it can't read.
function readFindings(report) {
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    return { failures: [`npm audit did not print JSON, so there is no report to check. ${RERUN_HINT}`] };
  }
  if (!isObject(parsed)) {
    return { failures: ['npm audit printed JSON that is not an audit report, so there is no report to check.'] };
  }
  if ('error' in parsed) {
    return {
      failures: [`npm audit reported an error (${errorDetail(parsed)}), so there is no report to check. ${RERUN_HINT}`],
    };
  }
  if (parsed.auditReportVersion !== REPORT_VERSION) {
    return {
      failures: [
        `npm audit printed auditReportVersion ${clean(JSON.stringify(parsed.auditReportVersion) ?? 'undefined')}, ` +
          `and this gate only reads version ${REPORT_VERSION}. Update ci/audit-gate.mjs for the new format.`,
      ],
    };
  }
  if (!isObject(parsed.vulnerabilities)) {
    return { failures: ['npm audit printed no vulnerabilities object, so there is no report to check.'] };
  }

  const findings = new Map();
  const failures = [];
  for (const [name, vulnerability] of Object.entries(parsed.vulnerabilities)) {
    if (!Array.isArray(vulnerability?.via)) {
      failures.push(`npm audit printed no via list for ${clean(name)}, so its advisories can't be checked.`);
      continue;
    }
    for (const via of vulnerability.via) {
      // A string only names another package, whose own entry has the advisory.
      if (typeof via === 'string') continue;
      if (!isObject(via)) {
        failures.push(`npm audit printed a via entry for ${clean(name)} that is neither a package nor an advisory.`);
        continue;
      }
      const pkg = clean(typeof via.name === 'string' ? via.name : name);
      const id = advisoryId(via);
      if (!KNOWN_SEVERITIES.includes(via.severity)) {
        failures.push(
          `npm audit printed advisory ${id} in ${pkg} with ${severityText(via.severity)}, ` +
            "so the gate can't tell whether it blocks.",
        );
        continue;
      }
      if (!BLOCKING_SEVERITIES.includes(via.severity)) continue;
      const finding = {
        severity: via.severity,
        package: pkg,
        id,
        title: typeof via.title === 'string' ? clean(via.title) : '',
        url: typeof via.url === 'string' ? clean(via.url).trim() : '',
      };
      findings.set(matchKey(id, pkg), finding);
    }
  }
  const sorted = [...findings.values()].sort(
    (a, b) =>
      BLOCKING_SEVERITIES.indexOf(a.severity) - BLOCKING_SEVERITIES.indexOf(b.severity) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
  return { findings: sorted, failures };
}

// `report` is the raw `npm audit --json` output, `allowlist` the parsed
// allowlist file, and `today` the UTC date as YYYY-MM-DD.
export function evaluateAudit({ report, allowlist, today }) {
  const todayNumber = dayNumber(today);
  if (todayNumber === null) {
    throw new TypeError(`today must be a YYYY-MM-DD date, not ${JSON.stringify(today)}.`);
  }
  const { entries, failures } = checkAllowlist(allowlist, todayNumber);
  const warnings = duplicateWarnings(entries);

  const read = readFindings(report);
  failures.push(...read.failures);
  if (!read.findings) return { findings: [], failures, warnings };

  const findings = read.findings.map((finding) => {
    const key = matchKey(finding.id, finding.package);
    const matches = entries.filter((entry) => entry.key === key);
    for (const entry of matches) entry.used = true;
    if (matches.length === 0) {
      failures.push(
        `${finding.severity} advisory ${finding.id} in ${finding.package} is not allowlisted: ${finding.title}. ` +
          `Upgrade ${finding.package}, or the package that pins it, to a release that fixes it. ` +
          'If no release does, add a dated entry to .github/audit-allowlist.json.',
      );
    }
    return { ...finding, allowlisted: matches.length > 0 };
  });
  for (const entry of entries) {
    if (!entry.used) warnings.push(`${entry.label} matches no high or critical advisory, so it can be deleted.`);
  }
  return { findings, failures, warnings };
}

// Workflow commands end at a newline, so encode the characters GitHub
// requires.
function escapeCommand(message) {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

// Text from the report or the allowlist, escaped for the step summary so it
// can't end a table cell, add HTML, or turn into a link.
function markdownText(value) {
  return clean(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\|[\]]/g, '\\$&');
}

function summaryMarkdown({ findings, failures, warnings }) {
  const lines = ['## Production audit', ''];
  if (findings.length === 0 && failures.length === 0) {
    lines.push(ALL_CLEAR);
  } else if (findings.length > 0) {
    lines.push('| Severity | Package | Advisory | Title | Allowlisted |', '| --- | --- | --- | --- | --- |');
    for (const finding of findings) {
      const id = SAFE_URL.test(finding.url) ? `[${markdownText(finding.id)}](${finding.url})` : markdownText(finding.id);
      lines.push(
        `| ${finding.severity} | ${markdownText(finding.package)} | ${id} | ${markdownText(finding.title)} | ` +
          `${finding.allowlisted ? 'yes' : 'no'} |`,
      );
    }
  }
  for (const [heading, items] of [
    ['Failures', failures],
    ['Warnings', warnings],
  ]) {
    if (items.length > 0) lines.push('', `**${heading}**`, '', ...items.map((item) => `- ${markdownText(item)}`));
  }
  return `${lines.join('\n')}\n`;
}

function readAllowlist(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Can't read the allowlist ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The allowlist ${file} is not valid JSON: ${error.message}`);
  }
}

function readReport(input) {
  if (input !== undefined) {
    try {
      return readFileSync(input, 'utf8');
    } catch (error) {
      throw new Error(`Can't read the audit report ${input}: ${error.message}`);
    }
  }
  // --offline=false keeps an offline setting in the environment or an .npmrc
  // from producing an empty report.
  const args = ['audit', '--omit=dev', '--json', '--offline=false', `--fetch-timeout=${NPM_FETCH_TIMEOUT_MS}`];
  const result = spawnSync('npm', args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: NPM_AUDIT_TIMEOUT_MS,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(
      `npm audit did not finish within ${NPM_AUDIT_TIMEOUT_MS / 1000} seconds, so there is no report to check. ${RERUN_HINT}`,
    );
  }
  if (result.error) {
    throw new Error(`Could not run npm audit: ${result.error.message}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  // The exit status is ignored on purpose: npm audit exits 1 for any advisory.
  return result.stdout;
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      allowlist: { type: 'string' },
    },
  });
  for (const name of ['input', 'allowlist']) {
    if (values[name] !== undefined && values[name].trim() === '') {
      throw new Error(`--${name} needs a file path. ${USAGE}`);
    }
  }
  const allowlistPath = values.allowlist ?? fileURLToPath(new URL('../.github/audit-allowlist.json', import.meta.url));
  const allowlist = readAllowlist(allowlistPath);
  const report = readReport(values.input);
  const today = new Date().toISOString().slice(0, 10);

  const result = evaluateAudit({ report, allowlist, today });

  // With a failure and no findings, the report may never have been read.
  if (result.findings.length === 0 && result.failures.length === 0) {
    console.log(ALL_CLEAR);
  }
  for (const finding of result.findings) {
    console.log(
      `${finding.severity} ${finding.package} ${finding.id} ${finding.title} ` +
        `(${finding.allowlisted ? 'allowlisted' : 'not allowlisted'})`,
    );
  }
  for (const warning of result.warnings) console.log(`::warning::${escapeCommand(warning)}`);
  for (const failure of result.failures) console.log(`::error::${escapeCommand(failure)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result));
  }
  return result.failures.length === 0;
}

function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  try {
    if (!main()) process.exitCode = 1;
  } catch (error) {
    const usage = String(error.code ?? '').startsWith('ERR_PARSE_ARGS') ? ` ${USAGE}` : '';
    console.log(`::error::${escapeCommand(clean(error.message))}${usage}`);
    process.exitCode = 1;
  }
}
