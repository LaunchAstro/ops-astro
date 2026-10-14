// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REQUIRED = [
  'the existing M5 target is healthy at its pinned version',
  'the M5 replay trace shows timings, outcome and call usage with no content',
  'terminal export shows the recorded outcome and call usage only from its business, run, lease and event time',
  'an exporter observed mid-run records the target outage while handback finishes and later catches up',
];

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A missing, failed, skipped or incomplete real-target report never means acceptance. */
export function acceptanceReportPasses(report: unknown): boolean {
  if (
    !object(report) ||
    report['success'] !== true ||
    report['numFailedTests'] !== 0 ||
    report['numPendingTests'] !== 0 ||
    (report['numTodoTests'] ?? 0) !== 0 ||
    typeof report['numTotalTests'] !== 'number' ||
    !Number.isSafeInteger(report['numTotalTests']) ||
    report['numTotalTests'] < REQUIRED.length ||
    !Array.isArray(report['testResults'])
  )
    return false;
  const suites: unknown[] = report['testResults'];
  const cases: unknown[] = suites.flatMap((suite) =>
    object(suite) && Array.isArray(suite['assertionResults']) ? suite['assertionResults'] : [],
  );
  return (
    cases.length === report['numTotalTests'] &&
    cases.every((one) => object(one) && one['status'] === 'passed') &&
    REQUIRED.every((name) =>
      cases.some((one) => object(one) && one['fullName'] === name && one['status'] === 'passed'),
    )
  );
}

function main(): number {
  const names = [
    'DATABASE_URL',
    'TRACE_TARGET_ENV_FILE',
    'TRACE_PROOF_TRACE_ID',
    'TRACE_PROOF_OUTCOME',
    'TRACE_PROOF_MODEL_CALLS',
    'TRACE_PROOF_SETTLED_CALLS',
    'TRACE_PROOF_MESSAGE_CANARY',
    'TRACE_PROOF_PAGE_CANARY',
    'TRACE_PROOF_TOOL_CANARY',
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`m5 trace proof: missing ${missing.join(', ')}`);
    return 1;
  }
  const fiveMinuteLoad = loadavg().at(1);
  if (fiveMinuteLoad === undefined || fiveMinuteLoad > 35) {
    console.error('m5 trace proof: held, five-minute load unavailable or exceeds 35');
    return 75;
  }
  return runProofCases();
}

function runProofCases(): number {
  const folder = mkdtempSync(join(tmpdir(), 'm5-trace-proof-'));
  const report = join(folder, 'vitest.json');
  try {
    execFileSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        'tests/runtime/aw-13-export.test.ts',
        'tests/runtime/m5-trace-live.test.ts',
        '--maxWorkers=1',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe', timeout: 600_000 },
    );
    if (!acceptanceReportPasses(JSON.parse(readFileSync(report, 'utf8')))) {
      console.error('m5 trace proof: required cases did not all pass without skips');
      return 1;
    }
    console.log(
      'm5 trace proof: target retrieval and isolated exporter cases passed; boot and live-stop evidence remain owner gates',
    );
    return 0;
  } catch {
    console.error('m5 trace proof: tests failed or produced no valid report');
    return 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = main();
