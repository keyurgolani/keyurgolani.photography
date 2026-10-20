// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAudit } from './audit-gate.mjs';

const TODAY = '2026-10-20';
const RERUN_HINT = 'If the registry was unreachable, rerun the job.';

// One advisory as npm audit --json prints it inside a `via` array.
function advisory(name, id, severity, fields = {}) {
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
    ...fields,
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

const NOT_ALLOWLISTED = expect.stringContaining('GHSA-aaaa-bbbb-cccc in sharp is not allowlisted');

describe('evaluateAudit', () => {
  it('passes a report with no advisories', () => {
    expect(evaluate({ report: auditReport() })).toEqual({ findings: [], failures: [], warnings: [] });
  });

  it('ignores info, low, and moderate advisories', () => {
    const report = auditReport(
      ['postcss', [advisory('postcss', 'GHSA-1111-2222-3333', 'moderate')]],
      ['esbuild', [advisory('esbuild', 'GHSA-4444-5555-6666', 'low')]],
      ['yaml', [advisory('yaml', 'GHSA-7777-8888-9999', 'info')]],
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
    expect(evaluate({ allowlist: [entry({ package: 'next' })] }).failures).toEqual([NOT_ALLOWLISTED]);
    expect(evaluate({ allowlist: [entry({ id: 'GHSA-aaaa-bbbb-dddd' })] }).failures).toEqual([NOT_ALLOWLISTED]);
  });

  it('passes an allowlisted high advisory', () => {
    const result = evaluate({ allowlist: [entry()] });
    expect(result.findings).toMatchObject([{ id: 'GHSA-aaaa-bbbb-cccc', package: 'sharp', allowlisted: true }]);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('matches an entry after trimming its id and package', () => {
    const result = evaluate({ allowlist: [entry({ id: '  GHSA-aaaa-bbbb-cccc ', package: ' sharp\t' })] });
    expect(result.failures).toEqual([]);
    expect(result.findings).toMatchObject([{ allowlisted: true }]);
  });

  it('matches a GHSA ID in any case', () => {
    const result = evaluate({ allowlist: [entry({ id: 'ghsa-AAAA-bbbb-CCCC' })] });
    expect(result.failures).toEqual([]);
    expect(result.findings).toMatchObject([{ allowlisted: true }]);
  });

  it('counts every entry for an advisory as used, and warns that they duplicate each other', () => {
    const result = evaluate({ allowlist: [entry({ expires: '2026-10-25' }), entry({ id: 'ghsa-aaaa-bbbb-cccc' })] });
    expect(result.failures).toEqual([]);
    expect(result.findings).toMatchObject([{ allowlisted: true }]);
    expect(result.warnings).toEqual([
      'Allowlist entries 1 and 2 cover the same advisory, GHSA-aaaa-bbbb-cccc in sharp. Keep the one that expires last.',
    ]);
  });

  it('names every duplicate entry', () => {
    const result = evaluate({ allowlist: [entry(), entry({ package: 'next' }), entry(), entry()] });
    expect(result.warnings).toEqual([
      'Allowlist entries 1, 3, and 4 cover the same advisory, GHSA-aaaa-bbbb-cccc in sharp. Keep the one that expires last.',
      'Allowlist entry 2 (GHSA-aaaa-bbbb-cccc in next) matches no high or critical advisory, so it can be deleted.',
    ]);
  });

  it('passes an entry that expires today', () => {
    expect(evaluate({ allowlist: [entry({ expires: TODAY })] }).failures).toEqual([]);
  });

  it('fails an entry that expired yesterday, and no longer covers its advisory', () => {
    const result = evaluate({ allowlist: [entry({ expires: '2026-10-19' })] });
    expect(result.failures).toEqual([
      'Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expired on 2026-10-19. Fix the advisory or renew the entry ' +
        'with a current reason, or delete the entry if it no longer matches anything.',
      NOT_ALLOWLISTED,
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

  it.each(['unknown', 'CVE-2026-12345', 'GHSA-aaaa-bbbb', 'GHSA-aaaa-bbbb-cccc-dddd', 'npm:', 'npm:12a', '1234'])(
    'fails an entry whose id is %j, which is neither a GHSA ID nor npm:<number>',
    (id) => {
      const result = evaluate({ allowlist: [entry({ id })] });
      expect(result.failures[0]).toBe(
        `Allowlist entry 1 (${id} in sharp) has the id "${id}", which is neither a GHSA ID nor npm:<number>.`,
      );
      expect(result.findings).toMatchObject([{ allowlisted: false }]);
    },
  );

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
    expect(result.failures).toEqual(['The allowlist must be a JSON array of entries.', NOT_ALLOWLISTED]);
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

  it('keys an advisory without a GHSA URL by its npm source number', () => {
    const report = auditReport([
      'sharp',
      [
        advisory('sharp', 'unused', 'high', { url: 'https://www.npmjs.com/advisories/1234', source: 1234 }),
        advisory('sharp', 'unused', 'high', { url: undefined, source: 5678 }),
      ],
    ]);
    const result = evaluate({ report, allowlist: [entry({ id: 'npm:1234' })] });
    expect(result.findings.map(({ id, allowlisted }) => `${id} ${allowlisted}`)).toEqual(['npm:1234 true', 'npm:5678 false']);
    expect(result.failures).toEqual([expect.stringContaining('high advisory npm:5678 in sharp is not allowlisted')]);
  });

  it('gives an advisory with neither a GHSA URL nor a source the id unknown, which no entry can cover', () => {
    const report = auditReport(['sharp', [advisory('sharp', 'unused', 'high', { url: undefined, source: undefined })]]);
    const result = evaluate({ report, allowlist: [entry({ id: 'unknown' })] });
    expect(result.findings).toMatchObject([{ id: 'unknown', allowlisted: false }]);
    expect(result.failures).toEqual([
      expect.stringContaining('has the id "unknown"'),
      expect.stringContaining('high advisory unknown in sharp is not allowlisted'),
    ]);
  });

  it('strips line breaks and other control characters from report text', () => {
    const report = auditReport([
      'sharp',
      [
        advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'high', {
          name: 'sh\narp',
          title: 'Bad\r\nthing\u0007here\u2028now',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc\n',
        }),
      ],
    ]);
    const [finding] = evaluate({ report }).findings;
    expect(finding).toMatchObject({
      package: 'sh arp',
      title: 'Bad thing here now',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    });
  });

  it.each(['', 'npm error code ENOTFOUND', '{"vulnerabilities": {'])('fails a report that is not JSON: %j', (report) => {
    expect(evaluate({ report })).toEqual({
      findings: [],
      failures: [`npm audit did not print JSON, so there is no report to check. ${RERUN_HINT}`],
      warnings: [],
    });
  });

  it.each([[], null, 'report', 3])('fails JSON that is not an audit report: %j', (parsed) => {
    expect(evaluate({ report: JSON.stringify(parsed) }).failures).toEqual([
      'npm audit printed JSON that is not an audit report, so there is no report to check.',
    ]);
  });

  // What npm 11 prints when the advisory endpoint fails: the detail is in
  // message and statusCode, and error.summary and error.detail are empty.
  it.each([
    [
      'answers 503',
      {
        message: '503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
        method: 'POST',
        uri: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
        headers: { 'content-type': ['text/plain'], 'x-fetch-attempts': ['1'] },
        statusCode: 503,
        body: 'Service Unavailable\n',
        error: { summary: '', detail: '' },
      },
      '503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    ],
    [
      'refuses the connection',
      {
        message:
          'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 104.16.0.35:443',
        error: { summary: '', detail: '' },
      },
      'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 104.16.0.35:443',
    ],
    [
      'times out',
      {
        message: 'network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
        error: { summary: '', detail: '' },
      },
      'network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    ],
  ])('fails with the message npm prints when the advisory endpoint %s', (_, parsed, detail) => {
    expect(evaluate({ report: JSON.stringify(parsed) })).toEqual({
      findings: [],
      failures: [`npm audit reported an error (${detail}), so there is no report to check. ${RERUN_HINT}`],
      warnings: [],
    });
  });

  it('adds the HTTP status when the message leaves it out', () => {
    const report = JSON.stringify({ message: 'Internal error', statusCode: 500, error: { summary: '', detail: '' } });
    expect(evaluate({ report }).failures).toEqual([
      `npm audit reported an error (HTTP 500: Internal error), so there is no report to check. ${RERUN_HINT}`,
    ]);
  });

  it('fails with the code and summary of an error such as a missing lockfile', () => {
    const report = JSON.stringify({
      error: {
        code: 'ENOLOCK',
        summary: 'This command requires an existing lockfile.',
        detail: 'Try creating one first with: npm i --package-lock-only\nOriginal error: loadVirtual requires existing shrinkwrap file',
      },
    });
    expect(evaluate({ report }).failures).toEqual([
      `npm audit reported an error (ENOLOCK: This command requires an existing lockfile.), so there is no report to check. ${RERUN_HINT}`,
    ]);
  });

  it.each([
    [{ error: { summary: '', detail: '' } }, '{"summary":"","detail":""}'],
    [{ error: 'unexpected', auditReportVersion: 2, vulnerabilities: {} }, '"unexpected"'],
  ])('fails a report with an error key and no message: %j', (parsed, detail) => {
    expect(evaluate({ report: JSON.stringify(parsed) }).failures).toEqual([
      `npm audit reported an error (${detail}), so there is no report to check. ${RERUN_HINT}`,
    ]);
  });

  it.each([
    [{ vulnerabilities: {} }, 'undefined'],
    [{ auditReportVersion: 1, vulnerabilities: {} }, '1'],
    [{ auditReportVersion: 3, vulnerabilities: {} }, '3'],
    [{ auditReportVersion: '2', vulnerabilities: {} }, '"2"'],
  ])('fails a report whose format version is not 2: %j', (parsed, version) => {
    expect(evaluate({ report: JSON.stringify(parsed) }).failures).toEqual([
      `npm audit printed auditReportVersion ${version}, and this gate only reads version 2. Update ci/audit-gate.mjs for the new format.`,
    ]);
  });

  it.each([{}, { vulnerabilities: null }, { vulnerabilities: [] }, { vulnerabilities: 'none' }])(
    'fails a report with no vulnerabilities object: %j',
    (fields) => {
      const report = JSON.stringify({ auditReportVersion: 2, ...fields });
      expect(evaluate({ report }).failures).toEqual([
        'npm audit printed no vulnerabilities object, so there is no report to check.',
      ]);
    },
  );

  it('fails a package entry with no via list', () => {
    const report = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { sharp: { name: 'sharp', severity: 'high' } } });
    expect(evaluate({ report }).failures).toEqual([
      "npm audit printed no via list for sharp, so its advisories can't be checked.",
    ]);
  });

  it.each([null, 7, ['postcss']])('fails a via entry that is %j', (via) => {
    const report = auditReport(['sharp', [via]]);
    expect(evaluate({ report }).failures).toEqual([
      'npm audit printed a via entry for sharp that is neither a package nor an advisory.',
    ]);
  });

  it.each([
    ['urgent', 'the severity "urgent"'],
    ['HIGH', 'the severity "HIGH"'],
    [undefined, 'no severity'],
  ])('fails an advisory with the severity %j, which it does not know', (severity, text) => {
    const report = auditReport(['sharp', [advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'high', { severity })]]);
    expect(evaluate({ report, allowlist: [entry()] }).failures).toEqual([
      `npm audit printed advisory GHSA-aaaa-bbbb-cccc in sharp with ${text}, so the gate can't tell whether it blocks.`,
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

  // Passes --input unless `args` replaces the arguments, so the tests never
  // run npm audit, and points GITHUB_STEP_SUMMARY at a temp file, so a CI
  // run's own summary is untouched.
  function run({ report = auditReport(), allowlist = [], args } = {}) {
    dir = mkdtempSync(path.join(tmpdir(), 'audit-gate-'));
    const reportPath = path.join(dir, 'report.json');
    const allowlistPath = path.join(dir, 'allowlist.json');
    const summaryPath = path.join(dir, 'summary.md');
    writeFileSync(reportPath, report);
    writeFileSync(allowlistPath, typeof allowlist === 'string' ? allowlist : JSON.stringify(allowlist));
    writeFileSync(summaryPath, '');
    const argv = [script, ...(args ?? ['--input', reportPath, '--allowlist', allowlistPath])];
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summaryPath };
    try {
      const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', env });
      return { status: 0, stdout, summary: readFileSync(summaryPath, 'utf8') };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, summary: readFileSync(summaryPath, 'utf8') };
    }
  }

  it('exits 0 for a report with no high or critical advisory', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No high or critical advisory in production dependencies.\n');
    expect(result.summary).toContain('No high or critical advisory in production dependencies.');
  });

  it('exits 1 and lists an unlisted advisory in the log and the step summary', () => {
    const result = run({ report: auditReport(['sharp', [SHARP_HIGH]]) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('high sharp GHSA-aaaa-bbbb-cccc A high advisory in sharp (not allowlisted)\n');
    expect(result.stdout).toContain('::error::high advisory GHSA-aaaa-bbbb-cccc in sharp is not allowlisted');
    expect(result.summary).toContain(
      '| high | sharp | [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | A high advisory in sharp | no |',
    );
  });

  it('keeps report text from adding log lines, workflow commands, table cells, HTML, or links', () => {
    const title = 'Bad | title <img src=x> \\ [click](https://example.com)\r\n::error::injected';
    const result = run({ report: auditReport(['sharp', [advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'high', { title })]]) });
    expect(result.status).toBe(1);
    expect(result.stdout.split('\n').filter((line) => line.startsWith('::error::injected'))).toEqual([]);
    expect(result.stdout).toContain(
      'high sharp GHSA-aaaa-bbbb-cccc Bad | title <img src=x> \\ [click](https://example.com) ::error::injected (not allowlisted)\n',
    );
    expect(result.summary).toContain(
      '| Bad \\| title &lt;img src=x&gt; \\\\ \\[click\\](https://example.com) ::error::injected | no |',
    );
    expect(result.summary).toContain(
      '- high advisory GHSA-aaaa-bbbb-cccc in sharp is not allowlisted: Bad \\| title &lt;img src=x&gt; \\\\ \\[click\\]',
    );
  });

  it.each([
    'javascript:alert(1)',
    'http://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    'https://github.com/advisories/GHSA-aaaa-bbbb-cccc (old)',
    'https://example.com/(x)/GHSA-aaaa-bbbb-cccc',
  ])('shows the advisory ID as plain text for the URL %j', (url) => {
    const result = run({ report: auditReport(['sharp', [advisory('sharp', 'GHSA-aaaa-bbbb-cccc', 'high', { url })]]) });
    expect(result.summary).toMatch(/^\| high \| sharp \| [^[\]]+ \| A high advisory in sharp \| no \|$/m);
  });

  it('exits 1, with no all-clear line, for a report it cannot read', () => {
    const result = run({ report: 'npm error code ENOTFOUND' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`::error::npm audit did not print JSON, so there is no report to check. ${RERUN_HINT}\n`);
    expect(result.summary).not.toContain('No high or critical advisory');
    expect(result.summary).toContain('**Failures**');
  });

  it('exits 1 for an allowlist entry that has expired', () => {
    const result = run({ report: auditReport(['sharp', [SHARP_HIGH]]), allowlist: [entry({ expires: '2000-01-01' })] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Allowlist entry 1 (GHSA-aaaa-bbbb-cccc in sharp) expired on 2000-01-01.');
  });

  it('exits 1 with a clear message for an allowlist that is not valid JSON', () => {
    const result = run({ allowlist: '[{"id": "GHSA-aaaa-bbbb-cccc",]' });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::The allowlist .*allowlist\.json is not valid JSON: /);
  });

  it.each(['--input', '--allowlist'])('treats an empty %s as a usage error, not a live audit', (flag) => {
    const result = run({ args: [`${flag}=`] });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      `::error::${flag} needs a file path. Usage: node ci/audit-gate.mjs [--input <report.json>] [--allowlist <allowlist.json>]\n`,
    );
  });

  it('prints the usage for an unknown option', () => {
    const result = run({ args: ['--inptu', 'report.json'] });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::.*'--inptu'.* Usage: node ci\/audit-gate\.mjs /);
  });
});
