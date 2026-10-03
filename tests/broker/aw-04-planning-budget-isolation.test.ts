// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning budget isolation`: the planning reply and the allowance read
// across another business, another client of the business (holding a share)
// and another person, and an agent under a live delegation for the owner.
// Each is refused with nothing written or sent, and reads nothing spent.

import { expect, it as vitestIt } from 'vitest';
import type { ModelCaller } from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createTask } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/t2d-harness.ts';
import { PLANTED_PROMPT, callCount, noDatabase, s, world } from './broker-world.ts';
import {
  allowance,
  ask,
  ownerOf,
  p,
  plan,
  setCap,
  usePlanningWorld,
} from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04planiso');

/** A client of alpha's, shared one task. */
async function sharedClient(): Promise<Member> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
  });
  const task = await createTask(s, 'aw04plan client task');
  return await cq8World(s).client(s.business, s.decider, 'aw04pc', task);
}

/** The world's agent under the live delegation its pickup holds, for the owner. */
async function agentUnderDelegation(): Promise<ModelCaller> {
  const [lease] = await s.db.admin.execute<{ delegation_id: string }>(
    'select delegation_id from public.leases where id = $1',
    [p.work.picked['leaseId']],
  );
  expect(lease?.delegation_id).toEqual(expect.any(String));
  return {
    actorId: s.agentActorId,
    delegationId: String(lease?.delegation_id),
    attendedByPersonId: s.decider.personId,
  };
}

it('AW-04 planning budget isolation: another business, another client, another person under a live delegation', async () => {
  const mine = ask(s);
  world.provider.mode('answer');
  await setCap(s, 5_000);
  expect(await plan(s, ownerOf(s), mine)).toMatchObject({ ok: true });
  const id = mine.conversation.id;
  const calls = await callCount();
  const foreign = new RegExp(`${id}|${s.business}|${PLANTED_PROMPT}`, 'u');

  // 1. Another business: bravo's owner, in bravo, naming alpha's conversation.
  const crossed = await plan(p.bravo, ownerOf(p.bravo), {
    ...mine,
    conversation: { ...mine.conversation, ownerPersonId: p.bravo.decider.personId },
  });
  expect(crossed).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  const bravoRead = await allowance(p.bravo, p.bravo.decider.personId, id);
  expect(bravoRead.conversation).toStrictEqual({ spentMinor: 0, heldMinor: 0 });
  expect(JSON.stringify([crossed, bravoRead])).not.toMatch(foreign);

  // 2. Another client of the business, shared one task: not the conversation's owner.
  const client = await sharedClient();
  const asClient = await plan(s, { ...ownerOf(s), attendedByPersonId: client.personId }, mine);
  expect(asClient).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  expect((await allowance(s, client.personId, id)).conversation).toStrictEqual({
    spentMinor: 0,
    heldMinor: 0,
  });

  // 3. Another person, and an agent acting under a live delegation for the owner.
  const other = await enrol(s.db.app, s.business, 'aw04plan-other');
  const asOther = await plan(s, { ...ownerOf(s), attendedByPersonId: other.personId }, mine);
  const asAgent = await plan(s, await agentUnderDelegation(), mine);
  for (const refused of [asOther, asAgent]) {
    expect(refused).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  }
  expect((await allowance(s, other.personId, id)).conversation).toStrictEqual({
    spentMinor: 0,
    heldMinor: 0,
  });
  expect(await callCount()).toBe(calls);
  expect(JSON.stringify([asClient, asOther, asAgent])).not.toMatch(foreign);
  // The owner's own read still shows the spend the crossings could not see.
  expect((await allowance(s, s.decider.personId, id)).conversation.spentMinor).toBeGreaterThan(0);
}, 120_000);
