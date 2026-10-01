// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313, batch 3b, defect 5: `run.delegate_child` faults on a
// lease id that is not a uuid. The operands keep any string `leaseId` as sent,
// and anything else as '' (agent-child.ts), and `lockHeldLease`
// (core-runtime child-work.ts) binds it straight to the uuid column of
// public.leases, so Postgres answers 22P02 and the call faults instead of being
// refused. The other hand-over fields are checked before anything is written
// (aw-11-child-commands.test.ts, "the hand-over body is checked"); the lease id
// is not.
//
// The case: the parent's own agent sends the hand-over with `leaseId`
// 'not-a-uuid', 7, and with no `leaseId` at all. Each must be refused
// LEASE_NOT_OWNED (or FIELD_VALUE_INVALID), with no child delegation written.
// On 51c13c7cb each call throws 22P02.

import { expect, it as vitestIt } from 'vitest';
import { codeOf as callOf, rows, type Body } from './schedules-harness.ts';
import { noDatabase, parentWork, useChildWorld, w } from './aw-11-child-world.ts';
import { delegateBody, delegateCall } from './aw-11-child-commands-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('rv3b5');

async function childCount(parentId: string): Promise<number> {
  const found = await rows<{ n: string }>(
    w.s,
    `select count(*)::text as n from public.delegations
      where business_id = $1 and parent_delegation_id = $2`,
    [w.s.business, parentId],
  );
  return Number(found[0]?.n);
}

/** The call's answer code, or the fault it threw, named with its SQLSTATE. */
async function answerOf(credential: string, body: Body): Promise<string> {
  try {
    return callOf(await delegateCall(w.s, credential, body));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return `threw ${String(code)}: ${(error as Error).message}`;
  }
}

/** Refused as the brief allows: the lease not the caller's, or the field invalid. */
const refusedAs = (code: string): boolean =>
  code === 'LEASE_NOT_OWNED' || code === 'FIELD_VALUE_INVALID';

it('REVIEW-3B-5: run.delegate_child refuses a leaseId that is not a uuid, a number or missing, and writes no child, instead of faulting 22P02', async () => {
  const mine = await parentWork(w.s);
  const withLease = (leaseId: unknown): Body => ({ ...delegateBody(mine.work, w.helper), leaseId });
  const missing = (): Body => {
    const { leaseId: _dropped, ...rest } = delegateBody(mine.work, w.helper);
    return rest;
  };
  const cases: readonly [string, Body][] = [
    ["'not-a-uuid'", withLease('not-a-uuid')],
    ['7', withLease(7)],
    ['missing', missing()],
  ];
  const answers: Record<string, string> = {};
  for (const [label, body] of cases) {
    // One call at a time: each answer is read on its own, nothing written between.
    // oxlint-disable-next-line no-await-in-loop
    answers[label] = await answerOf(mine.credential, body);
  }
  expect(
    Object.fromEntries(Object.entries(answers).map(([label, code]) => [label, refusedAs(code)])),
    `a bad leaseId faults instead of being refused: ${JSON.stringify(answers)}`,
  ).toStrictEqual({ "'not-a-uuid'": true, '7': true, missing: true });
  expect(await childCount(mine.parent.id)).toBe(0);
});
