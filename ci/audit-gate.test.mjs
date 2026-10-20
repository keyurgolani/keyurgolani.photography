// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAudit } from './audit-gate.mjs';

const TODAY = '2026-10-20';

// One advisory as npm audit --json prints it inside a `via` array.
function advisory(name, id, severity) {
  return {
    source: 1100000,
    name,
    dependency: name,
    title: `A ${severity} advisory in ${name}`,
    url: `https://github.com/advisories/${id}`,
    severity,
    cwe: [],
    cvss: { score: 0, vectorString: null },
    range: '<9.9.9',
  };
}

// The raw text of an npm audit --json report. Each argument is a package name
// and its `via` array.
function auditReport(...packages) {
  const vulnerabilities = {};
  for (const [name, via] of packages) {
    vulnerabilities[name] = {
      name,
      severity: 'high',
      isDirect: true,
      via,
      effects: [],
      range: '<9.9.9',
      nodes: [`node_modules/${name}`],
      fixAvailable: true,
    };
  }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: {} });
}

const SHARP_HIGH = advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'high');
const NEXT_CRITICAL = advisory('next', 'GHSA-dddd-eeee-ffff', 'critical');

function entry(fields = {}) {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    package: 'sharp',
    reason: 'The watcher never decodes the affected format.',
    expires: '2026-11-19',
    ...fields,
  };
}

function evaluate({ report = auditReport(['sharp', [SHARP_HIGH]]), allowlist = [] } = {}) {
  return evaluateAudit({ report, allowlist, today: TODAY });
}

describe('evaluateAudit', () => {
  it('passes a report with no advisories', () => {
    expect(evaluate({ report: auditReport() })).toEqual({ findings: [], failures: [], warnings: [] });
  });

  it('ignores moderate and low advisories', () => {
    const report = auditReport(
      ['postcss', [advisory('postcss', 'GHSA-1111-2222-3333', 'moderate')]],
      ['esbuild', [advisory('esbuild', 'GHSA-4444-5555-6666', 'low')]],
    );
    expect(evaluate({ report })).toEqual({ findings: [], failures: [], warnings: [] });
  });

  it('fails on an unlisted high advisory', () => {
    const result = evaluate();
    expect(result.findings).toEqual([
      {
        severity: 'high',
        package: 'sharp',
        id: 'GHSA-aaaa-bbbb-cccc',
        title: 'A high advisory in sharp',
        url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        allowlisted: false,
      },
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('high advisory GHSA-aaaa-bbbb-cccc in sharp is not allowlisted');
  });

  it('fails on an unlisted critical advisory', () => {
    const result = evaluate({ report: auditReport(['next', [NEXT_CRITICAL]]) });
    expect(result.findings).toMatchObject([{ severity: 'critical', package: 'next', id: 'GHSA-dddd-eeee-ffff' }]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('critical advisory GHSA-dddd-eeee-ffff in next is not allowlisted');
  });

  it('skips via strings, which point at another package entry', () => {
    const report = auditReport(['next', ['postcss', NEXT_CRITICAL]], ['postcss', [advisory('postcss', 'GHSA-7777-8888-9999', 'high')]]);
    const result = evaluate({ report });
    expect(result.findings.map(({ package: pkg, id }) => `${pkg} ${id}`)).toEqual([
      'next GHSA-dddd-eeee-ffff',
      'postcss GHSA-7777-8888-9999',
    ]);
    expect(result.failures).toHaveLength(2);
  });

  it('counts an advisory once per package', () => {
    const report = auditReport(['sharp', [SHARP_HIGH, SHARP_HIGH]]);
    expect(evaluate({ report }).findings).toHaveLength(1);
  });

  it('needs both the advisory ID and the package to match', () => {
    expect(evaluate({ allowlist: [entry({ package: 'next' })] }).failures).toEqual([
      expect.stringContaining('GHSA-aaaa-bbbb-cccc in sharp is not allowlisted'),
    ]);
    expect(evaluate({ allowlist: [entry({ id: 'GHSA-aaaa-bbbb-dddd' })] }).failures).toEqual([
      expect.stringContaining('GHSA-aaaa-bbbb-cccc in sharp is not allowlisted'),
    ]);
  });

  it('passes an allowlisted high advisory', () => {
    const result = evaluate({ allowlist: [entry()] });
    expect(result.findings).toMatchObject([{ id: 'GHSA-aaaa-bbbb-cccc', package: 'sharp', allowlisted: true }]);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('passes an entry that expires today', () => {
    expect(evaluate({ allowlist: [entry({ expires: TODAY })] }).failures).toEqual([]);
  });

  it('fails an entry that expired yesterday, and no longer covers its advisory', () => {
    const result = evaluate({ allowlist: [entry({ expires: '2026-10-19' })] });
    expect(result.failures).toEqual([
      'Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expired on 2026-10-19. Fix the advisory, or renew the entry with a current reason.',
      expect.stringContaining('GHSA-aaaa-bbbb-cccc in sharp is not allowlisted'),
    ]);
    expect(result.findings).toMatchObject([{ allowlisted: false }]);
  });

  it('passes an entry 90 days out', () => {
    expect(evaluate({ allowlist: [entry({ expires: '2027-01-18' })] }).failures).toEqual([]);
  });

  it.each(['2027-01-19', '2027-02-17'])('fails an entry that expires %s, more than 90 days out', (expires) => {
    const result = evaluate({ allowlist: [entry({ expires })] });
    expect(result.failures[0]).toBe(
      `Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expires ${expires}, more than 90 days out. Pick 2027-01-18 or earlier.`,
    );
    expect(result.findings).toMatchObject([{ allowlisted: false }]);
  });

  it.each(['id', 'package', 'reason', 'expires'])('fails an entry with no %s', (field) => {
    const incomplete = entry();
    delete incomplete[field];
    const result = evaluate({ allowlist: [incomplete] });
    expect(result.failures[0]).toMatch(new RegExp(`^Allowlist entry 1.* has no ${field}\\.`));
    expect(result.findings).toMatchObject([{ allowlisted: false }]);
  });

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a number', 7],
  ])('fails an entry whose reason is %s', (_, reason) => {
    expect(evaluate({ allowlist: [entry({ reason })] }).failures[0]).toContain('has no reason.');
  });

  it.each(['2026-11-1', '2026/11/19', '20261119', 'next month', '2026-02-30', '2026-13-01', '2026-11-19T00:00:00Z'])(
    'fails an entry that expires %j, which is not a YYYY-MM-DD date',
    (expires) => {
      const result = evaluate({ allowlist: [entry({ expires })] });
      expect(result.failures[0]).toBe(
        `Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expires "${expires}", which is not a YYYY-MM-DD date.`,
      );
    },
  );

  it.each([{}, null, 'GHSA-aaaa-bbbb-cccc', 3])('fails an allowlist that is %j, not an array', (allowlist) => {
    const result = evaluate({ allowlist });
    expect(result.failures).toEqual([
      'The allowlist must be a JSON array of entries.',
      expect.stringContaining('GHSA-aaaa-bbbb-cccc in sharp is not allowlisted'),
    ]);
  });

  it('fails an entry that is not an object', () => {
    expect(evaluate({ allowlist: ['GHSA-aaaa-bbbb-cccc'] }).failures[0]).toBe(
      'Allowlist entry 1 is not an object with id, package, reason, expires.',
    );
  });

  it('warns, without failing, on an entry that matches no advisory', () => {
    const result = evaluate({ report: auditReport(), allowlist: [entry()] });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      'Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) matches no high or critical advisory, so it can be deleted.',
    ]);
  });

  it('warns on an entry whose advisory dropped below high', () => {
    const report = auditReport(['sharp', [advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'moderate')]]);
    const result = evaluate({ report, allowlist: [entry()] });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it.each(['', 'npm error code ENOTFOUND', '{"vulnerabilities": {'])('fails a report that is not JSON: %j', (report) => {
    expect(evaluate({ report })).toEqual({
      findings: [],
      failures: [
        'npm audit did not print JSON, so there is no report to check. If the registry was unreachable, rerun the job.',
      ],
      warnings: [],
    });
  });

  it('fails a report with an error key', () => {
    const report = JSON.stringify({
      error: { code: 'ENOTFOUND', summary: 'request to the advisory endpoint failed', detail: '' },
    });
    expect(evaluate({ report }).failures).toEqual([
      'npm audit reported an error (ENOTFOUND: request to the advisory endpoint failed), so there is no report to check. ' +
        'If the registry was unreachable, rerun the job.',
    ]);
  });

  it('fails a report with an error key even when it lists vulnerabilities', () => {
    const report = JSON.stringify({ error: 'unexpected', vulnerabilities: {} });
    expect(evaluate({ report }).failures).toEqual([
      'npm audit reported an error ("unexpected"), so there is no report to check. If the registry was unreachable, rerun the job.',
    ]);
  });

  it.each([{}, { vulnerabilities: null }, { vulnerabilities: [] }, { vulnerabilities: 'none' }, [], null])(
    'fails a report with no vulnerabilities object: %j',
    (parsed) => {
      expect(evaluate({ report: JSON.stringify(parsed) }).failures).toEqual([
        'npm audit printed no vulnerabilities object, so there is no report to check.',
      ]);
    },
  );

  it('fails a package entry with no via list', () => {
    const report = JSON.stringify({ vulnerabilities: { sharp: { name: 'sharp', severity: 'high' } } });
    expect(evaluate({ report }).failures).toEqual([
      "npm audit printed no via list for sharp, so its advisories can't be checked.",
    ]);
  });

  it('still checks the allowlist, but warns about nothing, when the report is unreadable', () => {
    const result = evaluate({ report: 'not json', allowlist: [entry(), entry({ expires: '2026-10-01' })] });
    expect(result.failures).toEqual([
      expect.stringContaining('expired on 2026-10-01'),
      expect.stringContaining('npm audit did not print JSON'),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses a today that is not a YYYY-MM-DD date', () => {
    expect(() => evaluateAudit({ report: auditReport(), allowlist: [], today: '2026-10-20T12:00:00Z' })).toThrow(
      'today must be a YYYY-MM-DD date',
    );
  });
});

describe('audit-gate.mjs run directly', () => {
  const script = fileURLToPath(new URL('./audit-gate.mjs', import.meta.url));
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Always passes --input, so the tests never run npm audit, and points
  // GITHUB_STEP_SUMMARY at a temp file, so a CI run's own summary is untouched.
  function run({ report, allowlist }) {
    dir = mkdtempSync(path.join(tmpdir(), 'audit-gate-'));
    const reportPath = path.join(dir, 'report.json');
    const allowlistPath = path.join(dir, 'allowlist.json');
    const summaryPath = path.join(dir, 'summary.md');
    writeFileSync(reportPath, report);
    writeFileSync(allowlistPath, typeof allowlist === 'string' ? allowlist : JSON.stringify(allowlist));
    writeFileSync(summaryPath, '');
    const args = [script, '--input', reportPath, '--allowlist', allowlistPath];
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summaryPath };
    try {
      const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', env });
      return { status: 0, stdout, summary: readFileSync(summaryPath, 'utf8') };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, summary: readFileSync(summaryPath, 'utf8') };
    }
  }

  it('exits 0 for a report with no high or critical advisory', () => {
    const result = run({ report: auditReport(), allowlist: [] });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No high or critical advisory in production dependencies.\n');
    expect(result.summary).toContain('No high or critical advisory in production dependencies.');
  });

  it('exits 1 and lists an unlisted advisory in the log and the step summary', () => {
    const result = run({ report: auditReport(['sharp', [SHARP_HIGH]]), allowlist: [] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('high sharp GHSA-aaaa-bbbb-cccc A high advisory in sharp (not allowlisted)\n');
    expect(result.stdout).toContain('::error::high advisory GHSA-aaaa-bbbb-cccc in sharp is not allowlisted');
    expect(result.summary).toContain(
      '| high | sharp | [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | A high advisory in sharp | no |',
    );
  });

  it('exits 1, with no all-clear line, for a report it cannot read', () => {
    const result = run({ report: 'npm error code ENOTFOUND', allowlist: [] });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      '::error::npm audit did not print JSON, so there is no report to check. If the registry was unreachable, rerun the job.\n',
    );
    expect(result.summary).not.toContain('No high or critical advisory');
    expect(result.summary).toContain('**Failures**');
  });

  it('exits 1 for an allowlist entry that has expired', () => {
    const result = run({ report: auditReport(['sharp', [SHARP_HIGH]]), allowlist: [entry({ expires: '2000-01-01' })] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expired on 2000-01-01.');
  });

  it('exits 1 with a clear message for an allowlist that is not valid JSON', () => {
    const result = run({ report: auditReport(), allowlist: '[{"id": "GHSA-aaaa-bbbb-cccc",]' });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::The allowlist .*allowlist\.json is not valid JSON: /);
  });
});
