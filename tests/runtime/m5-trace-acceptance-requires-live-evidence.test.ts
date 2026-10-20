// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { acceptanceReportPasses } from '../../scripts/local/m5-trace-acceptance.ts';

it('the M5 acceptance command refuses missing prerequisites instead of a skipped pass', () => {
  const env = { ...process.env };
  delete env['DATABASE_URL'];
  delete env['TRACE_TARGET_ENV_FILE'];
  const result = spawnSync('node', ['scripts/local/m5-trace-acceptance.ts'], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('m5 trace proof: missing DATABASE_URL');
});

it('a green report containing skipped cases cannot accept the M5 trace setup', () => {
  expect(
    acceptanceReportPasses({
      success: true,
      numFailedTests: 0,
      numPendingTests: 1,
      numTotalTests: 1,
      testResults: [],
    }),
  ).toBe(false);
  expect(
    acceptanceReportPasses({
      success: true,
      numFailedTests: 0,
      numPendingTests: 0,
      numTotalTests: 0,
      testResults: [],
    }),
  ).toBe(false);
});

it('the trace proof report requires every named real-target and exporter case', () => {
  const names = [
    'the existing M5 target is healthy at its pinned version',
    'the existing M5 target listens on loopback only, restarts with Docker and keeps signup and media upload off',
    'the M5 replay trace shows timings, outcome and call usage with no content',
    'terminal export shows the recorded outcome and call usage only from its business, run, lease and event time',
    'an exporter observed mid-run records the target outage while handback finishes and later catches up',
  ];
  const report = {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTests: names.length,
    testResults: [{ assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })) }],
  };
  expect(acceptanceReportPasses(report)).toBe(true);
  expect(
    acceptanceReportPasses({
      ...report,
      testResults: [{ assertionResults: [{ fullName: names[0], status: 'passed' }] }],
    }),
  ).toBe(false);
  expect(acceptanceReportPasses({ ...report, numPendingTests: 1 })).toBe(false);
  const withoutSettings = names.filter((name) => !name.includes('loopback only'));
  expect(
    acceptanceReportPasses({
      ...report,
      numTotalTests: withoutSettings.length,
      testResults: [
        { assertionResults: withoutSettings.map((fullName) => ({ fullName, status: 'passed' })) },
      ],
    }),
  ).toBe(false);
});
