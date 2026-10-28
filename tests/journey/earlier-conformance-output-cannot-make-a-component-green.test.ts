// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression protection: two fixtures carried as they were written against
// the runner's earlier output, a counter line per suite and a problem list,
// with no verdict lines. Neither may ever read green. They pass today for a
// reason they do not name (there is no verdict line at all), so the proofs
// that the reader judges a failed assertion and a skip themselves are
// rebuilt on the runner's own verdict producer, beside the producer's tests.

import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PROTECTED, protectedVerdicts } from '../../scripts/local/journey-proofs.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';

const root = resolve(import.meta.dirname, '../..');

describe('regression protection: earlier conformance output fixtures', () => {
  test('a protected suite rejected for skipped tests cannot be green', () => {
    const suites = PROTECTED.flatMap(([, files]) => files);
    const suite = 'tests/records/records-integrity.test.ts';
    const output = [
      ...suites.map((file) => `db-conformance: ${file} moved the database counter by 12 in 1.2s.`),
      `db-conformance: ${suites.length} named suite(s), 100 test(s): 99 passed, 0 failed, 1 skipped`,
      'db-conformance: 2 problem(s)',
      '  1 named suite(s) cannot be bound to a result:',
      `          ${suite}\n            1 of its 5 test(s) did not run.`,
      '        Every suite the manifest names must appear in the report with',
      '        tests of its own that ran.',
    ].join('\n');
    const verdict = protectedVerdicts(output, readNamedSuites(root)).find(
      (line) => line.case === 'protected: domain model',
    );
    expect(verdict).toMatchObject({ status: 'fail' });
  }, 30_000);

  test('a protected suite with a failed assertion in the current conformance output cannot be green', () => {
    const suites = PROTECTED.flatMap(([, files]) => files);
    const suite = 'tests/records/records-integrity.test.ts';
    const output = [
      `db-conformance: failed assertion in ${suite}\n  a database assertion\nAssertionError: expected false to be true`,
      ...suites.map((file) => `db-conformance: ${file} moved the database counter by 12 in 1.2s.`),
      `db-conformance: ${suites.length} named suite(s), 100 test(s): 99 passed, 1 failed, 0 skipped`,
      'db-conformance: 2 problem(s)',
      '  1 database test(s) failed. See the assertion detail above.',
      `  vitest reported the run as failed, whatever the test counts say:\n          ${suite}: vitest exited with status 1`,
    ].join('\n');
    const verdict = protectedVerdicts(output, readNamedSuites(root)).find(
      (line) => line.case === 'protected: domain model',
    );
    expect(verdict?.status, JSON.stringify(verdict)).toBe('fail');
  }, 30_000);
});
