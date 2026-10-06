// SPDX-License-Identifier: AGPL-3.0-only
//
// O3 and R1 (docs/plan/sandbox-contract.md, sections 7 and 9): a run
// succeeds only with exit code 0, `OOMKilled` false, its deadline not
// reached and its output accepted. `memory` only when `OOMKilled` is true;
// any other failure to finish is `deadline` or `non-zero exit`. A daemon
// fault in the stream is `internal`. stderr is never an input. R1's reasons
// are a closed list, and a caller reads any other answer as `unavailable`.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readReason, REASONS } from '../../packages/core-sandbox/src/refusal.ts';
import { type RunEnd, runOutcome } from '../../packages/core-sandbox/src/run-outcome.ts';

const OK: RunEnd = { statusCode: 0, oomKilled: false, deadline: false, output: { ok: true } };
const TOO_LARGE = { ok: false, reason: 'output refused', why: 'too large' } as const;
const FAULT = { ok: false, reason: 'internal', why: 'reply body' } as const;
const outcome = (end: Partial<RunEnd>) => runOutcome({ ...OK, ...end });

it('succeeds only with exit 0, no OOM kill, no deadline and accepted output', () => {
  expect(outcome({})).toEqual({ ok: true });
  expect(outcome({ statusCode: 1 })).toEqual({ ok: false, reason: 'non-zero exit' });
  expect(outcome({ statusCode: 137 })).toEqual({ ok: false, reason: 'non-zero exit' });
  expect(outcome({ deadline: true })).toEqual({ ok: false, reason: 'deadline' });
  expect(outcome({ oomKilled: true })).toEqual({ ok: false, reason: 'memory' });
  expect(outcome({ output: TOO_LARGE })).toEqual({ ok: false, reason: 'output refused' });
  expect(outcome({ output: FAULT })).toEqual({ ok: false, reason: 'internal' });
});

it('reports memory only when OOMKilled is true, whatever the exit code', () => {
  expect(outcome({ statusCode: 137, oomKilled: false })).toEqual({
    ok: false,
    reason: 'non-zero exit',
  });
  expect(outcome({ statusCode: 137, oomKilled: true })).toEqual({ ok: false, reason: 'memory' });
  expect(outcome({ statusCode: 0, oomKilled: true })).toEqual({ ok: false, reason: 'memory' });
});

it('names the cause before its effects: a fault, then memory, then the deadline, then output', () => {
  expect(outcome({ output: FAULT, oomKilled: true, deadline: true })).toEqual({
    ok: false,
    reason: 'internal',
  });
  expect(outcome({ oomKilled: true, deadline: true, output: TOO_LARGE })).toEqual({
    ok: false,
    reason: 'memory',
  });
  expect(outcome({ deadline: true, statusCode: 137, output: TOO_LARGE })).toEqual({
    ok: false,
    reason: 'deadline',
  });
  expect(outcome({ statusCode: 137, output: TOO_LARGE })).toEqual({
    ok: false,
    reason: 'output refused',
  });
});

it("lists exactly R1's reasons, as the contract writes them", () => {
  const contract = readFileSync(
    new URL('../../docs/plan/sandbox-contract.md', import.meta.url),
    'utf8',
  );
  const clause = /\*\*R1\.\*\* Every failure is a refusal with a named reason: ([^.]+)\./u.exec(
    contract.replaceAll(/\s+/gu, ' '),
  );
  const named = (clause?.[1] ?? '').split(', ');
  expect(named.length).toBe(18);
  expect(REASONS).toEqual([...named, 'internal']);
});

it('reads any answer outside R1 as unavailable', () => {
  for (const reason of REASONS) expect(readReason(reason)).toBe(reason);
  for (const value of [
    'Deadline',
    'deadline ',
    'output_refused',
    '',
    'ok',
    null,
    42,
    {},
    ['memory'],
  ]) {
    expect(readReason(value)).toBe('unavailable');
  }
});
