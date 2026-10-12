// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (product issue 24): the protected set's proofs run green in the same
// run, one verdict per component, read from that run's own conformance output.
// A suite the manifest does not name, a suite that failed and a suite that
// never moved the database counter each fail their component.

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PROTECTED, protectedVerdicts } from '../../scripts/local/journey-proofs.ts';

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

// Exact counter lines retained from OA-Gates1559-57/component-proof.log, 14 October 2026.
// These are parser fixtures, not a fresh database proof.
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
const measuredManifest = { conformance: suites.slice(0, 11) };
const measured = (output: string, named = measuredManifest) =>
  protectedVerdicts(output, named).slice(0, 2);
const firstReceipt = retainedCounters.split('\n')[0] ?? '';

describe('protected verdicts read the stock runner counter grammar', () => {
  it('passes both measured components from the retained eleven timed receipts', () => {
    expect(measured(retainedCounters).map(({ status }) => status)).toStrictEqual(['pass', 'pass']);
    expect(measured(retainedCounters)[0]?.detail.split(', ')).toHaveLength(5);
    expect(measured(retainedCounters)[1]?.detail.split(', ')).toHaveLength(6);
  });

  it('keeps the existing positive threshold for the old and timed forms', () => {
    for (const output of [moved(suites), retainedCounters]) {
      expect(
        measured(output.replaceAll(/by \d+/gu, 'by 1')).map(({ status }) => status),
      ).toStrictEqual(['pass', 'pass']);
    }
  });
});

describe('protected verdicts refuse malformed counter receipts', () => {
  it.each(['0', '-1', '0.5', 'NaN', 'Infinity', '1e3', '15junk'])(
    'refuses a missing positive integer counter: %s',
    (counter) => {
      for (const suffix of ['.', ' in 1.1s.']) {
        const receipt = firstReceipt.replace('15 in 1.1s.', `${counter}${suffix}`);
        const base =
          suffix === '.' ? retainedCounters.replaceAll(/ in \d+\.\ds/gu, '') : retainedCounters;
        const original = suffix === '.' ? firstReceipt.replace(' in 1.1s', '') : firstReceipt;
        expect(measured(base.replace(original, receipt))[0]).toMatchObject({
          status: 'fail',
          detail: expect.stringContaining('records-integrity.test.ts did not reach the database'),
        });
      }
    },
  );

  it.each([
    '15 in NaNs.',
    '15 in -1.1s.',
    '15 in 1s.',
    '15 in 1.1s',
    '15 in 1.1s. junk',
    '15. junk',
  ])('refuses a malformed counter receipt: %s', (tail) => {
    expect(measured(retainedCounters.replace('15 in 1.1s.', tail))[0]?.status).toBe('fail');
  });
});

describe('protected verdicts keep the runner receipt boundaries', () => {
  it('fails a suite with no receipt, no database use, or only a discovery line', () => {
    for (const replacement of [
      '',
      'db-conformance: tests/records/records-integrity.test.ts was not measured: a counter read failed.',
      'tests/records/records-integrity.test.ts > discovers 20 tests',
    ]) {
      expect(
        measured(retainedCounters.replace(firstReceipt, replacement)).map(({ status }) => status),
      ).toStrictEqual(['fail', 'pass']);
    }
    expect(measured('11 suites, 222 tests discovered').map(({ status }) => status)).toStrictEqual([
      'fail',
      'fail',
    ]);
  });

  it('keeps manifest and failed-suite refusals with a healthy timed receipt', () => {
    expect(measured(retainedCounters, { conformance: suites.slice(1, 11) })[0]?.status).toBe(
      'fail',
    );
    expect(
      measured(
        `${retainedCounters}\n FAIL tests/records/records-integrity.test.ts > no database use`,
      )[0]?.status,
    ).toBe('fail');
  });

  it('fails the missing component without borrowing another component counter', () => {
    expect(
      measured(retainedCounters.split('\n').slice(0, 5).join('\n')).map(({ status }) => status),
    ).toStrictEqual(['pass', 'fail']);
  });

  it('reads the same receipts after terminal colour controls are stripped', () => {
    const coloured = `\u001B[32m${retainedCounters}\u001B[0m`;
    expect(measured(stripVTControlCharacters(coloured)).map(({ status }) => status)).toStrictEqual([
      'pass',
      'pass',
    ]);
  });
});
