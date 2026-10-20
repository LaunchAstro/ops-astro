// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (product issue 24): the protected set's proofs run green in the same
// run, one verdict per component, read from that run's own conformance output.
// A suite the manifest does not name, a suite that failed and a suite that
// never moved the database counter each fail their component.

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ItemResult,
  PROTECTED,
  protectedVerdicts,
  verdictLine,
} from '../../scripts/local/journey-proofs.ts';

const suites = PROTECTED.flatMap(([, files]) => files);
const manifest = { invariant: suites, conformance: [], restartLeg: true };
const moved = (files: readonly string[]): string =>
  files.map((file) => `db-conformance: verdict ok ${file}: 3 test(s) passed`).join('\n');
const verdicts = (output: string, named = manifest) => protectedVerdicts(output, named);

describe('the protected set, one verdict per component from the same run', () => {
  it('names the four components and queue and delivery', () => {
    const names = verdicts(moved(suites)).map((verdict) => verdict.case);
    expect(names).toStrictEqual([
      'protected: domain model',
      'protected: tenancy wrapper',
      'protected: migrations',
      'protected: gate engine',
      'protected: queue and delivery',
    ]);
  });

  it('passes a component whose every suite is named, reached the database and did not fail', () => {
    const all = verdicts(moved(suites));
    expect(all.map((verdict) => verdict.status)).toStrictEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('fails a component for a failed suite, an unnamed one, and one that never reached the database', () => {
    const [first, second] = suites;
    const failed = verdicts(
      `${moved(suites.slice(1))}\ndb-conformance: verdict failed ${String(first)}: failed assertion`,
    );
    expect(failed.find((verdict) => verdict.detail.includes(String(first)))?.status).toBe('fail');
    const unnamed = verdicts(moved(suites), { ...manifest, invariant: suites.slice(1) });
    expect(unnamed[0]).toMatchObject({ status: 'fail' });
    expect(unnamed[0]?.detail).toContain(`${String(first)} is not named`);
    const silent = verdicts(moved(suites.filter((file) => file !== second)));
    expect(silent.find((verdict) => verdict.detail.includes(String(second)))?.status).toBe('fail');
  });
});

// Exact counter lines retained from OA-Gates1559-57/component-proof.log, 14
// October 2026, when the reader parsed these lines and missed the runner's
// timing suffix (b5a76b967, 8863e7a2e). The count now reaches the reader as
// a number, through the verdict line the runner prints beside each receipt
// (scripts/db-conformance.mjs), so a timed receipt never decides a verdict.
const retainedCounters = `db-conformance: tests/records/records-integrity.test.ts moved the database counter by 15 in 1.1s.
db-conformance: tests/records/slot-law.test.ts moved the database counter by 15 in 0.7s.
db-conformance: tests/records/model-negatives.test.ts moved the database counter by 41 in 3.9s.
db-conformance: tests/tasks/task-model.test.ts moved the database counter by 15 in 0.8s.
db-conformance: tests/tasks/task-spine.test.ts moved the database counter by 15 in 0.9s.
db-conformance: tests/tenancy/tenancy-conformance.test.ts moved the database counter by 15 in 0.9s.
db-conformance: tests/tenancy/tenancy-wrapper.test.ts moved the database counter by 17 in 2.8s.
db-conformance: tests/tenancy/wrapper-mutation.test.ts moved the database counter by 67 in 5.5s.
db-conformance: tests/tenancy/pooled-crossover.test.ts moved the database counter by 15 in 1.7s.
db-conformance: tests/tenancy/t4-worker-role.test.ts moved the database counter by 15 in 0.8s.
db-conformance: tests/tenancy/t4-no-notify.test.ts moved the database counter by 15 in 2.8s.`;

it('a timed counter receipt beside its verdict line passes on the numeric count', () => {
  const root = resolve(import.meta.dirname, '../..');
  const receipts = [
    ...retainedCounters.matchAll(/^db-conformance: (\S+) moved .* by (\d+) in /gmu),
  ];
  const lines = receipts.map(([, item = '', count]) => {
    const result: ItemResult = {
      run: { status: 0, signal: null },
      report: {
        success: true,
        testResults: [{ name: resolve(root, item), assertionResults: [{ status: 'passed' }] }],
      },
      moved: Number(count),
      clientSessions: 1,
      cost: 2,
    };
    return verdictLine(item, result);
  });
  const named = { conformance: receipts.map(([, item = '']) => item) };
  const [model, tenancy] = protectedVerdicts(`${retainedCounters}\n${lines.join('\n')}`, named);
  expect([model?.status, tenancy?.status], JSON.stringify([model, tenancy])).toStrictEqual([
    'pass',
    'pass',
  ]);
  expect(lines[2]).toContain('the counter moved by 41');
});
