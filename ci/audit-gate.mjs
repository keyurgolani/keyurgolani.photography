// Production audit gate for the `audit` job in .github/workflows/ci.yml.
//
// It fails on a high or critical advisory in a production dependency unless
// .github/audit-allowlist.json lists it. Each allowlist entry looks like
//
//   { "id": "GHSA-xxxx-xxxx-xxxx", "package": "name",
//     "reason": "Why the advisory doesn't reach this site.",
//     "expires": "YYYY-MM-DD" }
//
// and covers that advisory in that package through its expires date (UTC),
// which is at most 90 days out. An entry is the last resort, for when no
// release of the package, or of the parent that pins it, fixes the advisory.
// Try an npm `overrides` pin first.
//
// Run directly, it runs `npm audit --omit=dev --json` and decides from the
// JSON alone, because npm audit exits 1 for any advisory, moderate and
// allowlisted ones included.
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
const ENTRY_FIELDS = ['id', 'package', 'reason', 'expires'];
const MAX_ALLOWLIST_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RERUN_HINT = 'If the registry was unreachable, rerun the job.';
const ALL_CLEAR = 'No high or critical advisory in production dependencies.';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function describeEntry(entry, index) {
  const id = isObject(entry) && typeof entry.id === 'string' && entry.id ? entry.id : null;
  const pkg = isObject(entry) && typeof entry.package === 'string' && entry.package ? entry.package : null;
  const label = [id, pkg && `in ${pkg}`].filter(Boolean).join(' ');
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
    const expires = dayNumber(entry.expires);
    if (expires === null) {
      failures.push(`${label} expires "${entry.expires}", which is not a YYYY-MM-DD date.`);
    } else if (expires < today) {
      failures.push(`${label} expired on ${entry.expires}. Fix the advisory, or renew the entry with a current reason.`);
    } else if (expires - today > MAX_ALLOWLIST_DAYS) {
      failures.push(
        `${label} expires ${entry.expires}, more than ${MAX_ALLOWLIST_DAYS} days out. ` +
          `Pick ${dateFromDayNumber(today + MAX_ALLOWLIST_DAYS)} or earlier.`,
      );
    } else {
      entries.push(entry);
    }
  });
  return { entries, failures };
}

// The advisory ID is the GHSA-xxxx-xxxx-xxxx at the end of its URL.
function advisoryId(url) {
  return (typeof url === 'string' ? url.replace(/\/+$/, '').split('/').pop() : '') || 'unknown';
}

// Returns the high and critical advisories in the report, one per advisory ID
// and package, or a failure when the report can't be read.
function readFindings(report) {
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    return {
      failures: [`npm audit did not print JSON, so there is no report to check. ${RERUN_HINT}`],
    };
  }
  if (isObject(parsed) && 'error' in parsed) {
    const { code, summary } = isObject(parsed.error) ? parsed.error : {};
    const detail = [code, summary].filter(Boolean).join(': ') || JSON.stringify(parsed.error);
    return { failures: [`npm audit reported an error (${detail}), so there is no report to check. ${RERUN_HINT}`] };
  }
  if (!isObject(parsed?.vulnerabilities)) {
    return { failures: ['npm audit printed no vulnerabilities object, so there is no report to check.'] };
  }

  const findings = new Map();
  const failures = [];
  for (const [name, vulnerability] of Object.entries(parsed.vulnerabilities)) {
    if (!Array.isArray(vulnerability?.via)) {
      failures.push(`npm audit printed no via list for ${name}, so its advisories can't be checked.`);
      continue;
    }
    for (const via of vulnerability.via) {
      // A string only names another package, whose own entry has the advisory.
      if (!isObject(via) || !BLOCKING_SEVERITIES.includes(via.severity)) continue;
      const finding = {
        severity: via.severity,
        package: typeof via.name === 'string' ? via.name : name,
        id: advisoryId(via.url),
        title: typeof via.title === 'string' ? via.title : '',
        url: typeof via.url === 'string' ? via.url : '',
      };
      findings.set(`${finding.id} ${finding.package}`, finding);
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
  const warnings = [];

  const read = readFindings(report);
  failures.push(...read.failures);
  if (!read.findings) return { findings: [], failures, warnings };

  const used = new Set();
  const findings = read.findings.map((finding) => {
    const entry = entries.find((candidate) => candidate.id === finding.id && candidate.package === finding.package);
    if (entry) {
      used.add(entry);
    } else {
      failures.push(
        `${finding.severity} advisory ${finding.id} in ${finding.package} is not allowlisted: ${finding.title}. ` +
          `Upgrade ${finding.package}, or the package that pins it, to a release that fixes it. ` +
          'If no release does, add a dated entry to .github/audit-allowlist.json.',
      );
    }
    return { ...finding, allowlisted: Boolean(entry) };
  });
  entries.forEach((entry) => {
    if (!used.has(entry)) {
      warnings.push(
        `${describeEntry(entry, allowlist.indexOf(entry))} matches no high or critical advisory, so it can be deleted.`,
      );
    }
  });
  return { findings, failures, warnings };
}

// Workflow commands end at a newline, so encode the characters GitHub
// requires.
function escapeCommand(message) {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function tableCell(value) {
  return String(value).replace(/\s+/g, ' ').replaceAll('|', '\\|');
}

function summaryMarkdown({ findings, failures, warnings }) {
  const lines = ['## Production audit', ''];
  if (findings.length === 0 && failures.length === 0) {
    lines.push(ALL_CLEAR);
  } else if (findings.length > 0) {
    lines.push('| Severity | Package | Advisory | Title | Allowlisted |', '| --- | --- | --- | --- | --- |');
    for (const finding of findings) {
      const id = finding.url ? `[${tableCell(finding.id)}](${finding.url})` : tableCell(finding.id);
      lines.push(
        `| ${finding.severity} | ${tableCell(finding.package)} | ${id} | ${tableCell(finding.title)} | ${finding.allowlisted ? 'yes' : 'no'} |`,
      );
    }
  }
  for (const [heading, items] of [
    ['Failures', failures],
    ['Warnings', warnings],
  ]) {
    if (items.length > 0) lines.push('', `**${heading}**`, '', ...items.map((item) => `- ${item}`));
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
  if (input) {
    try {
      return readFileSync(input, 'utf8');
    } catch (error) {
      throw new Error(`Can't read the audit report ${input}: ${error.message}`);
    }
  }
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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
    console.log(`::error::${escapeCommand(error.message)}`);
    process.exitCode = 1;
  }
}
