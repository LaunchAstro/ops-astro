// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (product issue 24): the protected set's proofs run green in the same
// run, one verdict per component, read from that run's own conformance output.
// A suite the manifest does not name, a suite that failed and a suite that
// never moved the database counter each fail their component.

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
