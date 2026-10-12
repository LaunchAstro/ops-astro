// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { codeOf, rows } from '../runtime/schedules-harness.ts';
import { asksOn, pickupOf, spentWhole } from '../runtime/resume-sizing-world.ts';

useBrokerWorld('spentholdlivedelegation');

it('a spent-hold pickup refuses another live delegation for its purpose without raising an ask', async () => {
  const work = await spentWhole('existing live purpose');
  const [old] = await rows<{
    agent_actor_id: string;
    delegate_person_id: string;
    minted_by_actor_id: string;
    purpose: string;
    collections: string[];
    actions: Parameters<typeof mintDelegation>[1]['actions'];
  }>(s, 'select * from public.delegations where id = $1', [work.picked['delegationId']]);
  if (old === undefined) throw new Error('Expected the revoked delegation');
  const live = await s.db.app.withBusiness(s.business, (tx) =>
    mintDelegation(tx, {
      agentActorId: old.agent_actor_id,
      delegatePersonId: old.delegate_person_id,
      mintedByActorId: old.minted_by_actor_id,
      purpose: old.purpose,
      collections: old.collections,
      actions: old.actions,
      purposeScope: { kind: 'record', id: work.taskId },
      expiresAt: new Date(Date.now() + 600_000),
    }),
  );
  expect(live).toMatchObject({ ok: true });
  expect(await asksOn(work)).toHaveLength(0);
  const result = await pickupOf(work);
  expect({ code: codeOf(result), asks: [...(await asksOn(work))] }).toStrictEqual({
    code: 'DELEGATION_ALREADY_LIVE',
    asks: [],
  });
});
