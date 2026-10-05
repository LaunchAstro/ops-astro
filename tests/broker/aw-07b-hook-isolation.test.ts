// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b isolation, on the inbound side: a verified delivery event moves the
// attempt of the message it names and nothing else, across each crossing the
// data is separated on. Another business; another client in the same business;
// another person of the same client on the same task, whose agent holds a
// live delegation on it. The hook takes no person grant, so the crossing is
// held by the message id alone, and each case checks the other side unmoved.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { insertAgentActor } from '../identity/fixture.ts';
import { attemptsOf, noDatabase, useEmailWorld, w } from './email-world.ts';
import { eventBody, mountHook, post, sentItem } from './email-hook-world.ts';
import { extra, useTimingWorld } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();
beforeAll(() => {
  mountHook();
});

const states = async (item: string): Promise<readonly string[]> =>
  (await attemptsOf(item)).map((row) => row.state);

/** A live delegation from `person` to a fresh agent, on `task`: written as the application role. */
async function liveDelegation(person: string, task: string): Promise<string> {
  return await w.db.app.withBusiness(w.alpha, async (tx) => {
    const agent = await insertAgentActor(tx);
    const [minted] = await tx.query<{ id: string }>(
      'select id from public.actors where business_id = $1 and person_id = $2 limit 1',
      [tx.businessId, person],
    );
    await tx.query(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
       values ($1, gen_random_uuid(), $2, $3, $4, 'hook_isolation', array['task'],
               array['read', 'comment'], $5, now() + interval '1 hour', 'record', $6)`,
      [tx.businessId, agent, person, minted?.id, randomUUID().replaceAll('-', '').repeat(2), task],
    );
    const [live] = await tx.query<{ n: string }>(
      `select count(*)::text as n from public.delegations
        where business_id = $1 and agent_actor_id = $2 and revoked_at is null and expires_at > now()`,
      [tx.businessId, agent],
    );
    if (live?.n !== '1') throw new Error('hook isolation: the delegation is not live');
    return agent;
  });
}

it('AW-07b isolation (hook): an event moves only the attempt of the business that sent it', async () => {
  const alpha = await sentItem();
  const bravo = await sentItem({ id: w.bravo, person: w.bravoPerson, task: w.bravoTask });
  expect(await post(eventBody('email.delivered', bravo.messageId))).toMatchObject({
    code: 'DELIVERED',
  });
  expect(await states(bravo.item)).toEqual(['asked', 'accepted', 'delivered']);
  expect(await states(alpha.item)).toEqual(['asked', 'accepted']);
  // A message id no business in the deployment sent: not found, nothing written.
  const before = await w.db.admin.execute('select id from public.inbox_delivery_attempts');
  expect(await post(eventBody('email.delivered', 'no-such-message'))).toMatchObject({
    status: 404,
    code: 'UNKNOWN_MESSAGE',
  });
  expect(await w.db.admin.execute('select id from public.inbox_delivery_attempts')).toHaveLength(
    before.length,
  );
});

it('AW-07b isolation (hook): in one business, an event for one client’s message never moves another client’s', async () => {
  const clientA = await sentItem();
  const clientB = await sentItem({ id: w.alpha, person: extra.clientB, task: w.otherTask });
  expect(await post(eventBody('email.bounced', clientB.messageId))).toMatchObject({
    code: 'BOUNCED',
  });
  expect(await states(clientB.item)).toEqual(['asked', 'accepted', 'failed']);
  expect(await states(clientA.item)).toEqual(['asked', 'accepted']);
  expect(await post(eventBody('email.delivered', clientA.messageId))).toMatchObject({
    code: 'DELIVERED',
  });
  expect(await states(clientA.item)).toEqual(['asked', 'accepted', 'delivered']);
  expect(await states(clientB.item)).toEqual(['asked', 'accepted', 'failed']);
});

it('AW-07b isolation (hook): on one task, an event for one person’s message never moves another person’s, the other’s agent under a live delegation included', async () => {
  await liveDelegation(extra.clientA2, w.task);
  const ada = await sentItem();
  const delegating = await sentItem({ id: w.alpha, person: extra.clientA2, task: w.task });
  expect(await post(eventBody('email.delivered', delegating.messageId))).toMatchObject({
    code: 'DELIVERED',
  });
  expect(await states(delegating.item)).toEqual(['asked', 'accepted', 'delivered']);
  expect(await states(ada.item)).toEqual(['asked', 'accepted']);
  expect(await post(eventBody('email.bounced', ada.messageId))).toMatchObject({
    code: 'BOUNCED',
  });
  expect(await states(ada.item)).toEqual(['asked', 'accepted', 'failed']);
  expect(await states(delegating.item)).toEqual(['asked', 'accepted', 'delivered']);
});
