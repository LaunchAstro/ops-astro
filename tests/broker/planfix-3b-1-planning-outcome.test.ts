// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313 finding 3b-1, beside its proof
// (`review-3b-1-planning-hold-released.test.ts`): a planning reply held
// unknown is reached by the provider phase when its operation declares a
// lookup, and a person's outcome on it is the conversation owner's alone.
// Another person of the business, holding budget permission, and another
// business's owner, both naming the owner's conversation and call, are
// refused `NOT_FOUND` with nothing written; the owner's outcome then settles
// it, and a second outcome on it is refused.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { callModelForPlanning } from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { asPerson, codeOf } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { CLOUD, LOCAL, noDatabase, s, world } from './broker-world.ts';
import { faultBroker, pass } from './aw-10-world.ts';
import {
  allowance,
  ask,
  local,
  ownerOf,
  p,
  plan,
  rowsFor,
  usePlanningWorld,
} from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('pf3b1');

beforeAll(async () => {
  if (noDatabase) return;
  await openBilling(s);
  await openBilling(p.bravo);
}, 60_000);

const outcomeBody = (conversationId: string, callId: unknown, outcome: string) => ({
  command: 'budget.record_outcome',
  operationId: randomUUID(),
  recordId: conversationId,
  attemptId: callId,
  outcome,
});

it('PLANFIX-3B-1: a planning reply whose operation declares a lookup is released by the pass alone', async () => {
  const request = ask(s);
  const before = await allowance(s, s.decider.personId, request.conversation.id);
  world.provider.mode('cut');
  world.provider.lookupMode('honest');
  const failed = await callModelForPlanning(s.db.app, s.business, ownerOf(s), request, {
    ...faultBroker(),
    routes: [LOCAL],
    audit: local(s).audit,
  });
  world.provider.mode('answer');
  expect(failed).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
  expect(await rowsFor(s, request.conversation.id)).toMatchObject([
    { state: 'liability_unknown', reconcile_mode: 'provider_lookup' },
  ]);

  await pass(s, { ...faultBroker(), routes: [LOCAL, CLOUD] });

  expect(await rowsFor(s, request.conversation.id)).toMatchObject([
    { state: 'released', outcome: null },
  ]);
  expect((await allowance(s, s.decider.personId, request.conversation.id)).leftMinor).toBe(
    before.leftMinor,
  );
});

it("PLANFIX-3B-1: only the conversation's owner records a planning reply's outcome, once", async () => {
  const request = ask(s);
  world.provider.mode('cut');
  const failed = await plan(s, ownerOf(s), request);
  world.provider.mode('answer');
  const callId = 'callId' in failed ? failed.callId : null;
  expect(failed).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  const id = request.conversation.id;

  // Another person of the business, holding budget permission on all of it.
  const other = await enrol(s.db.app, s.business, 'pf3b1-other');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, other, 'decide', undefined, false, 'billing');
  });
  const asOther = await executeCommand(
    s.db.app,
    s.business,
    other.presented,
    'api',
    outcomeBody(id, callId, 'nothing_happened') as never,
  );
  expect(codeOf(asOther)).toBe('NOT_FOUND');
  expect(JSON.stringify(asOther)).not.toContain(id);
  // Another business's owner, in their own business, naming this one's call.
  expect(codeOf(await asPerson(p.bravo, outcomeBody(id, callId, 'nothing_happened')))).toBe(
    'NOT_FOUND',
  );
  expect(await rowsFor(s, id)).toMatchObject([
    { state: 'liability_unknown', outcome: null, outcome_person_id: null },
  ]);

  // The owner: it happened, so the hold is spent at its maximum, in their name.
  expect(codeOf(await asPerson(s, outcomeBody(id, callId, 'happened')))).toBe('applied');
  expect(await rowsFor(s, id)).toMatchObject([
    {
      state: 'settled',
      outcome: 'happened',
      actual_minor: '500',
      outcome_person_id: s.decider.personId,
    },
  ]);
  expect(codeOf(await asPerson(s, outcomeBody(id, callId, 'nothing_happened')))).toBe(
    'LIABILITY_NOT_UNKNOWN',
  );
});
