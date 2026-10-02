// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 item 7, the security pass's findings table and severity gate
// (`scripts/security/findings.ts`, run by `findings.mjs` in the security scan
// job). Planted ZAP reports in the shape ZAP 2.17's `-J` report writes. The
// mapping is the closing rule's (S0-5.md:63): high is a blocker, medium a
// major, low a minor; informational is listed apart and never fails (ORCH65,
// 2 Oct 2026); a blank or unknown risk code is a blocker.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  findingsOf,
  findingsTable,
  ReportRefused,
  severityGate,
} from '../../scripts/security/findings.ts';

const MARKER = 'planted-bearer-9f3c1d7e5b2a4680';

interface PlantedAlert {
  readonly riskcode?: string | undefined;
  readonly name?: string;
  readonly pluginid?: string;
  readonly instances?: readonly Record<string, string>[];
}

function report(alerts: readonly PlantedAlert[]): unknown {
  return {
    '@programName': 'ZAP',
    '@version': '2.17.0',
    site: [
      {
        '@name': 'https://staging.example.test',
        alerts: alerts.map((alert, index) => ({
          pluginid: alert.pluginid ?? String(10_000 + index),
          alert: alert.name ?? `Planted alert ${String(index)}`,
          name: alert.name ?? `Planted alert ${String(index)}`,
          ...(alert.riskcode === undefined ? {} : { riskcode: alert.riskcode }),
          confidence: '2',
          instances: alert.instances ?? [
            {
              uri: `https://staging.example.test/api/b/alpha/task/create?n=${String(index)}`,
              method: 'POST',
              evidence: 'planted evidence',
            },
          ],
        })),
      },
    ],
  };
}

it('a high is a blocker, a medium a major and a low a minor, each with its URL, rule and evidence', () => {
  const found = findingsOf(
    'api',
    report([
      { riskcode: '3', name: 'SQL Injection', pluginid: '40018' },
      { riskcode: '2', name: 'CSP Header Not Set', pluginid: '10038' },
      { riskcode: '1', name: 'Server Leaks Version', pluginid: '10036' },
    ]),
  );
  expect(found.findings.map((each) => [each.severity, each.rule])).toStrictEqual([
    ['blocker', '40018 SQL Injection'],
    ['major', '10038 CSP Header Not Set'],
    ['minor', '10036 Server Leaks Version'],
  ]);
  expect(found.findings[0]).toMatchObject({
    scan: 'api',
    method: 'POST',
    url: 'https://staging.example.test/api/b/alpha/task/create?n=0',
    evidence: 'planted evidence',
  });
  expect(found.info).toStrictEqual([]);
});

it('informational alerts go to the info list, never the findings', () => {
  const found = findingsOf('baseline', report([{ riskcode: '0', name: 'Modern Web App' }]));
  expect(found.findings).toStrictEqual([]);
  expect(found.info.map((each) => each.rule)).toStrictEqual(['10000 Modern Web App']);
});

it.each([
  ['blank', ''],
  ['missing', undefined],
  ['unknown', '4'],
  ['a word', 'High'],
  ['padded', ' 3'],
])('a %s risk code is a blocker that names what it read', (_label, riskcode) => {
  const found = findingsOf('api', report([{ riskcode, name: 'Odd risk' }]));
  expect(found.findings.map((each) => each.severity)).toStrictEqual(['blocker']);
  expect(found.findings[0]?.rule).toContain('unmapped risk code');
});

it('one row per instance; an alert with no instance still gets a row', () => {
  const found = findingsOf(
    'api',
    report([
      {
        riskcode: '1',
        instances: [
          { uri: 'https://staging.example.test/a', method: 'GET' },
          { uri: 'https://staging.example.test/b', method: 'GET' },
        ],
      },
      { riskcode: '2', instances: [] },
    ]),
  );
  expect(found.findings.map((each) => [each.severity, each.url])).toStrictEqual([
    ['major', '(no URL given)'],
    ['minor', 'https://staging.example.test/a'],
    ['minor', 'https://staging.example.test/b'],
  ]);
});

it.each([
  ['not an object', 'ZAP failed'],
  ['no site list', { '@programName': 'ZAP' }],
  ['an empty site list', { '@programName': 'ZAP', site: [] }],
  ['a site whose alerts are not a list', { site: [{ '@name': 'x', alerts: 'none' }] }],
  ['an alert that is not an object', { site: [{ '@name': 'x', alerts: ['High'] }] }],
])('a report with %s is refused, so a scan that reached nothing never passes', (_l, body) => {
  expect(() => findingsOf('api', body)).toThrow(ReportRefused);
});

it('a planted credential marker in a URL, parameter or evidence never reaches the table', () => {
  const found = findingsOf(
    'api',
    report([
      {
        riskcode: '2',
        instances: [
          {
            uri: `https://staging.example.test/x?token=${MARKER}`,
            method: 'GET',
            param: `Authorization: Bearer ${MARKER}`,
            evidence: `echoed ${MARKER} back`,
          },
        ],
      },
    ]),
    [MARKER],
  );
  const table = findingsTable([found]);
  expect(JSON.stringify(found)).not.toContain(MARKER);
  expect(table).not.toContain(MARKER);
  expect(table).toContain('[redacted]');
});

it('a pipe, a newline or markup in the evidence cannot break the table', () => {
  const found = findingsOf(
    'api',
    report([
      {
        riskcode: '1',
        instances: [{ uri: 'https://s.test/a|b', evidence: 'one | two\n<script>x</script>' }],
      },
    ]),
  );
  const row = findingsTable([found])
    .split('\n')
    .find((line) => line.startsWith('| minor'));
  expect(row).toBeDefined();
  // Five cells: severity, scan, URL, rule, evidence; every pipe inside one is escaped.
  expect(row?.replaceAll('\\|', '').split('|').length).toBe(7);
  expect(row).not.toContain('<script>');
});

it('long evidence is cut to 200 characters', () => {
  const found = findingsOf(
    'api',
    report([
      { riskcode: '1', instances: [{ uri: 'https://s.test/', evidence: 'x'.repeat(5000) }] },
    ]),
  );
  expect(found.findings[0]?.evidence.length).toBeLessThanOrEqual(201);
});

it('a blocker or a major fails the run; minors alone pass and are listed for the owner', () => {
  const blocker = findingsOf('api', report([{ riskcode: '3' }, { riskcode: '1' }]));
  const major = findingsOf('api', report([{ riskcode: '2' }]));
  const minor = findingsOf('api', report([{ riskcode: '1' }, { riskcode: '0' }]));
  expect(severityGate([blocker])).toMatchObject({ fails: true, blocker: 1, minor: 1 });
  expect(severityGate([major])).toMatchObject({ fails: true, major: 1 });
  expect(severityGate([minor])).toStrictEqual({
    fails: false,
    blocker: 0,
    major: 0,
    minor: 1,
    info: 1,
  });
  const table = findingsTable([minor]);
  expect(table).toContain('impact, a compensating control and an expiry');
});

it('a clean scan passes with an empty table', () => {
  const clean = findingsOf('baseline', report([]));
  expect(severityGate([clean]).fails).toBe(false);
  expect(findingsTable([clean])).toContain('No findings');
});

const command = (args: readonly string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['scripts/security/findings.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const dir = mkdtempSync(join(tmpdir(), 'sec-scan-findings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('writes the table and the JSON, exits 1 on a major and keeps the planted marker out of every output', () => {
  const planted = join(dir, 'api.json');
  writeFileSync(
    planted,
    JSON.stringify(
      report([{ riskcode: '2', instances: [{ uri: `https://s.test/?t=${MARKER}` }] }]),
    ),
  );
  const out = join(dir, 'out-major');
  const run = command(['--report', `api=${planted}`, '--out', out, '--redact-env', 'SCAN_T'], {
    SCAN_T: MARKER,
  });
  expect(run.status).toBe(1);
  const table = readFileSync(join(out, 'findings.md'), 'utf8');
  const json = readFileSync(join(out, 'findings.json'), 'utf8');
  for (const text of [table, json, run.stdout, run.stderr]) expect(text).not.toContain(MARKER);
  expect(table).toContain('| major | api |');
});

it('exits 0 on minors alone and 1 on a missing report', () => {
  const planted = join(dir, 'baseline.json');
  writeFileSync(planted, JSON.stringify(report([{ riskcode: '1' }])));
  const pass = command(['--report', `baseline=${planted}`, '--out', join(dir, 'out-minor')]);
  expect(pass.status, pass.stderr).toBe(0);
  const missing = command([
    '--report',
    `baseline=${join(dir, 'absent.json')}`,
    '--out',
    join(dir, 'out-missing'),
  ]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('baseline');
});
