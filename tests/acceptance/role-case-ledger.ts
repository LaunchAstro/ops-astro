// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix itself: what was observed, what was expected, and the file it is
// written to.
//
// It is its own file for T1h's reason — the per-file cap is 400 changed lines,
// no waiver lifts it, and the answer is to split the file rather than the
// change or the comments that say why an assertion is the assertion. The seam
// is the obvious one: this module knows nothing about tasks, agents or
// businesses, only about rows.
//
// **Where an expected status comes from.** The code is the domain's and the
// status is the transport's, and neither is derived from the other
// (`apps/api/status.ts`). So `refusal()` reads the status out of that table
// rather than out of anyone's memory, and no case in this suite writes a
// status literal beside a code. A test that remembered the pairing would keep
// passing after the product changed it, which is the one failure a matrix of
// this kind cannot afford.

import { mkdirSync, writeFileSync } from 'node:fs';
import type { RefusalCode } from '../../packages/core-records/src/commands/register.ts';
import { statusFor } from '../../apps/api/status.ts';
import type { Answer } from './world.ts';

/** One observation. The run writes every one of these out, pass or fail. */
export interface Row {
  readonly role: string;
  readonly case: string;
  readonly operation: string;
  readonly observedCode: string;
  readonly observedStatus: number;
  readonly expectedCode: string;
  readonly expectedStatus: number;
  readonly verdict: 'pass' | 'fail' | 'exception';
}

/** The expectation an observation is compared with: a code and its status. */
export interface Expected {
  readonly code: string;
  readonly status: number;
}

const matrix: Row[] = [];

/** A success, spelled the way `call` spells one, so the two are comparable. */
export const SUCCESS: Expected = { code: 'ok', status: 200 };

/** A refusal, with its status taken from the product's own table. */
export const refusal = (code: RefusalCode): Expected => ({ code, status: statusFor(code) });

export function observe(
  role: string,
  kase: string,
  operation: string,
  answer: Answer,
  expected: Expected,
): void {
  const passed = answer.code === expected.code && answer.status === expected.status;
  matrix.push({
    role,
    case: kase,
    operation,
    observedCode: answer.code,
    observedStatus: answer.status,
    expectedCode: expected.code,
    expectedStatus: expected.status,
    verdict: passed ? 'pass' : 'fail',
  });
}

/**
 * A declaration that cannot be driven, with the reason in place of a verdict.
 *
 * A named exception is a row and not a gap: the matrix still carries an entry
 * for that role against that endpoint, and the entry says why nothing could be
 * measured. Leaving it out would make a case that was never asked look exactly
 * like a case that passed, which is the one thing a coverage claim must not do.
 */
export function except(role: string, kase: string, operation: string, reason: string): void {
  matrix.push({
    role,
    case: kase,
    operation,
    observedCode: reason,
    observedStatus: 0,
    expectedCode: reason,
    expectedStatus: 0,
    verdict: 'exception',
  });
}

/** The failing rows of one case, named, so the assertion prints what went wrong. */
export const failures = (kase: string): readonly string[] =>
  matrix
    .filter((row) => row.case === kase && row.verdict === 'fail')
    .map(
      (row) =>
        `${row.case} ${row.role}/${row.operation}: got ${String(row.observedStatus)} ` +
        `${row.observedCode}, expected ${String(row.expectedStatus)} ${row.expectedCode}`,
    );

const COLUMNS =
  'role\tcase\toperation\tobservedCode\tobservedStatus\texpectedCode\texpectedStatus\tverdict';

/**
 * The matrix, written whole, and one line a reader can act on.
 *
 * A failing row is in the file for the same reason a passing one is: the file
 * is the evidence, and evidence that only records agreement is not evidence.
 * The summary line prints the failing rows by name so a run that is read in a
 * terminal says which case broke without anyone opening the file.
 */
export function writeMatrix(path = '.local/l5-matrix.tsv'): void {
  mkdirSync('.local', { recursive: true });
  const body = matrix
    .map((row) =>
      [
        row.role,
        row.case,
        row.operation,
        row.observedCode,
        String(row.observedStatus),
        row.expectedCode,
        String(row.expectedStatus),
        row.verdict,
      ].join('\t'),
    )
    .join('\n');
  writeFileSync(path, `${COLUMNS}\n${body}\n`, 'utf8');
  const failed = matrix.filter((row) => row.verdict === 'fail');
  const exceptions = matrix.filter((row) => row.verdict === 'exception');
  const passed = matrix.length - failed.length - exceptions.length;
  console.log(
    `matrix: ${String(matrix.length)} rows, ${String(passed)} passed, ` +
      `${String(failed.length)} failed, ${String(exceptions.length)} named exceptions` +
      (failed.length === 0
        ? ''
        : `; failing: ${failed
            .map((row) => `${row.case} ${row.role}/${row.operation}=${row.observedCode}`)
            .join(', ')}`),
  );
}
