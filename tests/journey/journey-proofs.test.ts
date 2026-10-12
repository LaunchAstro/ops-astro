// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (product issue 24): the protected set's proofs run green in the same
// run, one verdict per component, read from that run's own conformance output.
// A suite the manifest does not name, a suite that failed and a suite that
// never moved the database counter each fail their component.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTECTED, protectedVerdicts, UNRUN } from '../../scripts/local/journey-proofs.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const suites = PROTECTED.flatMap(([, files]) => files);
const manifest = { invariant: suites, conformance: [] };
// The line scripts/db-conformance.mjs prints for each suite it measured.
const moved = (files: readonly string[]): string =>
  files
    .map((file) => `db-conformance: ${file} moved the database counter by 12 in 1.2s.`)
    .join('\n');
const verdicts = (output: string, named = manifest) => protectedVerdicts(output, named);

describe('the protected set, one verdict per component from the same run', () => {
  it('names the five components', () => {
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
    expect(verdicts(moved(suites)).map((verdict) => verdict.status)).toStrictEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('reads a suite run in parts by its own path', () => {
    const parted = suites.map((file) => `${file}#1/2`).concat(suites.map((file) => `${file}#2/2`));
    expect(verdicts(moved(parted)).every((verdict) => verdict.status === 'pass')).toBe(true);
  });

  it('passes every component against the real manifest when its suites all reached the database', () => {
    const named = readNamedSuites(ROOT);
    expect(suites.filter((file) => !existsSync(resolve(ROOT, file)))).toStrictEqual([]);
    expect(
      protectedVerdicts(moved(suites), named).filter((verdict) => verdict.status !== 'pass'),
    ).toStrictEqual([]);
  });

  it('fails a component for a failed suite, an unnamed one, and one that never reached the database', () => {
    const [first, second] = suites;
    const failed = verdicts(`${moved(suites)}\n FAIL  ${String(first)} > a case`);
    expect(failed.find((verdict) => verdict.detail.includes(String(first)))?.status).toBe('fail');
    const unnamed = verdicts(moved(suites), { invariant: suites.slice(1), conformance: [] });
    expect(unnamed[0]).toMatchObject({ status: 'fail' });
    expect(unnamed[0]?.detail).toContain(`${String(first)} is not named`);
    const silent = verdicts(moved(suites.filter((file) => file !== second)));
    expect(silent.find((verdict) => verdict.detail.includes(String(second)))?.status).toBe('fail');
  });
});

describe('what the journey reports it could not run', () => {
  it('names no capability whose suites the manifest already runs', () => {
    const named = readNamedSuites(ROOT);
    const all = [...(named.invariant ?? []), ...(named.conformance ?? [])];
    const landed = UNRUN.map(([name]) => name).filter((name) => {
      const owner = /^(T\d[a-z]\d?)\b/u.exec(name)?.[1]?.toLowerCase();
      return owner !== undefined && all.some((suite) => suite.includes(`/${owner}-`));
    });
    expect(landed).toStrictEqual([]);
  });
});
