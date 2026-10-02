// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313, batch 3b, defect 1: a planning reply's hold is never
// released. A planning call carries no reservation_id, and every path that ends
// an unknown call finds it by one: the provider phase of the pass joins
// attempts on reservation_id (`broker-reconcile.ts`), and a person's outcome or
// write-off resolves calls by reservation_id (`resolveHeldCalls`,
// `recovery/broker-effect.ts`). So a failed planning reply stays held as
// unknown liability against the business's planning cap for ever.
//
// The case: a planning reply the connection cuts (the provider never began it)
// is held liability_unknown at its maximum. Then the reconciliation pass runs
// with the provider's honest lookup, which proves nothing happened, and the
// person who owns the conversation attempts to record that nothing happened.
// After both, the call must have left liability_unknown and the planning
// allowance must have its 500 back. On 5e8385cf5 neither path reaches the
// call, so it stays held and leftMinor stays 500 short.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { asPerson } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { CLOUD, LOCAL, noDatabase, s, world } from './broker-world.ts';
import { faultBroker, pass } from './aw-10-world.ts';
import {
  allowance,
  ask,
  ownerOf,
  plan,
  rowsFor,
  usePlanningWorld,
} from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('rv3b1');

beforeAll(async () => {
  if (noDatabase) return;
  // Budget permission for the decider, so the person's outcome is theirs to record.
  await openBilling(s);
}, 60_000);

it('REVIEW-3B-1: a failed planning reply held liability_unknown is released by the pass or a person, and the planning allowance gets its hold back', async () => {
  const request = ask(s);
  const before = await allowance(s, s.decider.personId, request.conversation.id);

  // The connection is cut: the provider never began the work, and the reply is held.
  world.provider.mode('cut');
  world.provider.lookupMode('honest');
  const failed = await plan(s, ownerOf(s), request);
  expect(failed).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
  const callId = 'callId' in failed ? failed.callId : null;
  expect(callId).toEqual(expect.any(String));
  expect(await rowsFor(s, request.conversation.id)).toMatchObject([
    { state: 'liability_unknown', reserved_minor: '500' },
  ]);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    leftMinor: before.leftMinor - 500,
    conversation: { heldMinor: 500 },
  });
  world.provider.mode('answer');

  // The recovery pass, provider phase included, on a broker that reaches the
  // planning route and declares the replay lookup: an honest lookup proves
  // the provider never began the call.
  await pass(s, { ...faultBroker(), routes: [LOCAL, CLOUD] });

  // The conversation's owner, holding budget permission, records that nothing happened.
  await asPerson(s, {
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: request.conversation.id,
    attemptId: callId,
    outcome: 'nothing_happened',
  });

  const [row] = await rowsFor(s, request.conversation.id);
  expect(
    row?.['state'],
    'the planning call is still liability_unknown after the pass and the person: nothing reaches a call with no reservation_id',
  ).not.toBe('liability_unknown');
  expect(
    (await allowance(s, s.decider.personId, request.conversation.id)).leftMinor,
    "the planning allowance's leftMinor never recovers the failed reply's 500 hold",
  ).toBe(before.leftMinor);
});
