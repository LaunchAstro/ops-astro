// SPDX-License-Identifier: AGPL-3.0-only
//
// `verdictLine`, the producer `db-conformance` prints each run item's verdict
// with, judges the item from its own report: `ok` only when the report names
// exactly the requested file and some of its tests ran. A failed assertion
// and a skip fail the protected component by that detail, each beside a
// passing control that differs from it only in the failure, so neither case
// can pass for a missing verdict instead.

import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  type ItemResult,
  PROTECTED,
  protectedVerdicts,
  verdictLine,
} from '../../scripts/local/journey-proofs.ts';

const root = resolve(import.meta.dirname, '../..');
const suites = PROTECTED.flatMap(([, files]) => files);
const SUITE = 'tests/records/records-integrity.test.ts';

/** A run of `suite` whose report names `file` and holds tests of these statuses. */
const result = (file: string, statuses: readonly string[]): ItemResult => ({
  run: { status: 0, signal: null },
  report: {
    success: true,
    errors: [],
    testResults: [
      {
        name: resolve(root, file),
        message: '',
        assertionResults: statuses.map((status) => ({ status })),
      },
    ],
  },
  moved: 12,
  clientSessions: 1,
  cost: 2,
});
const PASSED = ['passed', 'passed', 'passed'];

/** The domain model's verdict when SUITE's three tests have these statuses and every other suite passed. */
const domainModel = (statuses: readonly string[]) => {
  const lines = suites.map((suite) =>
    verdictLine(suite, result(suite, suite === SUITE ? statuses : PASSED)),
  );
  const expected = { invariant: suites, conformance: [], restartLeg: true };
  return protectedVerdicts(lines.join('\n'), expected).find(
    (verdict) => verdict.case === 'protected: domain model',
  );
};

it('a report of another file gives a failed verdict', () => {
  expect(verdictLine(SUITE, result(SUITE, PASSED))).toMatch(/^db-conformance: verdict ok /u);
  const other = verdictLine(SUITE, result('tests/records/slot-law.test.ts', PASSED));
  expect(other).toBe(
    `db-conformance: verdict failed ${SUITE}: the report is not of this file alone`,
  );
});

it('a suite with no executed assertions gives a failed verdict', () => {
  expect(verdictLine(SUITE, result(SUITE, []))).toBe(
    `db-conformance: verdict failed ${SUITE}: no executed assertions`,
  );
});

it('a failed assertion fails its component by that detail, beside a passing control', () => {
  expect(domainModel(PASSED)?.status).toBe('pass');
  const failed = domainModel(['passed', 'failed', 'passed']);
  expect(failed?.status).toBe('fail');
  expect(failed?.detail).toBe(`${SUITE}: failed assertion`);
  expect(failed?.detail).not.toContain('no verdict in this run');
});

it('a skipped test fails its component by that detail, beside a passing control', () => {
  expect(domainModel(PASSED)?.status).toBe('pass');
  const skipped = domainModel(['passed', 'skipped', 'passed']);
  expect(skipped?.status).toBe('fail');
  expect(skipped?.detail).toBe(`${SUITE}: skipped`);
  expect(skipped?.detail).not.toContain('no verdict in this run');
});
