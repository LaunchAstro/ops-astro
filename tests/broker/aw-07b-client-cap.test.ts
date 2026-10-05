// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b client cap (owner answer 20, CS-16.9): relationship mail to a client
// is one email a week per client across every source, in the send path; a
// mention a person wrote is transactional and outside the cap; one an agent
// wrote is relationship mail inside it; every client send carries its class.
// And AW-07b isolation for the batch: two businesses, two clients, another
// person, and one person to another under a live delegation, each checked by
// what was mailed and what was written.

import { expect, it as vitestIt } from 'vitest';
import { askOne } from '../../packages/core-custody/src/broker-email.ts';
import { emailDailyBatch } from '../../packages/core-custody/src/index.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import {
  aged,
  commentBy,
  extra,
  freshInbox,
  heldOpen,
  stillWaiting,
  timing,
  useTimingWorld,
} from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

const batch = async (person: string, business: string = w.alpha) =>
  await emailDailyBatch(w.db.app, business, person, timing());

/** A client comment item on a task for a recipient, its comment written by a person or an agent. */
async function clientItem(task: string, author: 'person' | 'agent', to: string = w.person) {
  const comment = await commentBy(task, author);
  return await w.db.app.withBusiness(
    w.alpha,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: to,
        subjectRecordId: task,
        reason: 'client_comment',
        fact: { kind: 'record', id: comment },
      }),
  );
}

const asked = async (item: string) => (await attemptsOf(item)).find((row) => row.state === 'asked');

it('AW-07b client cap: one relationship email a week per client; a person-written mention is transactional', async () => {
  await freshInbox();
  const sent = w.provider.outbox.length;
  // An agent-written mention: relationship mail, the client's one this week.
  const first = await clientItem(w.task, 'agent');
  expect(await batch(w.person)).toMatchObject({ ok: true, items: 1 });
  expect((await asked(first))?.evidence).toBe('batch:daily class:relationship');
  // The next day, another agent-written mention to the same client is held:
  // nothing is sent or written, and the item stands.
  await aged('25 hours');
  const second = await clientItem(w.task, 'agent');
  expect(await batch(w.person)).toEqual({ ok: false, code: 'NOTHING_WAITING' });
  expect(await attemptsOf(second)).toEqual([]);
  expect(w.provider.outbox.length).toBe(sent + 1);
  // A person-written mention takes its own path: transactional, outside the cap.
  const personal = await clientItem(w.task, 'person');
  expect(await batch(w.person)).toMatchObject({ ok: true, items: 1 });
  expect((await asked(personal))?.evidence).toBe('batch:daily class:transactional');
  expect(await attemptsOf(second)).toEqual([]);
  // Another client in the same business has a week of its own.
  const otherClient = await clientItem(w.otherTask, 'agent', extra.clientB);
  expect(await batch(extra.clientB)).toMatchObject({ ok: true, items: 1 });
  expect((await asked(otherClient))?.evidence).toBe('batch:daily class:relationship');
  // A week on, the held one goes.
  await aged('8 days');
  expect(await batch(w.person)).toMatchObject({ ok: true, items: 1 });
  expect((await asked(second))?.evidence).toBe('batch:daily class:relationship');
  expect(w.provider.outbox.length).toBe(sent + 4);
});

it('AW-07b client cap: a second sender to the same client waits for the first and holds its item', async () => {
  await freshInbox();
  const sent = w.provider.outbox.length;
  const first = await clientItem(w.task, 'agent');
  const second = await clientItem(w.task, 'agent', extra.clientA2);
  // A sender to client A has checked the week and recorded its ask, not yet committed.
  // The concurrency ceiling is not what this case holds, so the sender always has room.
  const sender = await heldOpen(async (tx) => await askOne(tx, first, () => Promise.resolve(true)));
  // Another of the client's people is batched meanwhile: it waits on the client's lock.
  const racing = batch(extra.clientA2);
  const waited = await stillWaiting(racing);
  await sender.release();
  expect(waited).toBe(true);
  expect(await racing).toEqual({ ok: false, code: 'NOTHING_WAITING' });
  expect(w.provider.outbox.length).toBe(sent);
  expect(await attemptsOf(second)).toEqual([]);
  expect(await asked(first)).toEqual({ state: 'asked', evidence: 'class:relationship' });
});

it('AW-07b isolation (batch): another business, another client and another person are never batched', async () => {
  await freshInbox();
  const sent = w.provider.outbox.length;
  const mine = await itemFor(w.task, 'mention');
  // The same business, a task of a client the recipient cannot read: left out.
  const otherClient = await itemFor(w.otherTask, 'mention');
  // Another person's item in the same business: never in this person's email.
  const someoneElse = await clientItem(w.otherTask, 'person', extra.clientB);
  // Another business's item, and its person named from this business: nothing.
  const bravoItem = await itemFor(w.bravoTask, 'mention', { id: w.bravo, person: w.bravoPerson });
  expect(await batch(w.bravoPerson, w.alpha)).toEqual({ ok: false, code: 'NOTHING_WAITING' });
  expect(await attemptsOf(bravoItem)).toEqual([]);
  expect(await batch(w.person)).toMatchObject({ ok: true, items: 1 });
  expect(w.provider.outbox.length).toBe(sent + 1);
  const body = w.provider.outbox.at(-1)?.body ?? '';
  for (const foreign of [otherClient, someoneElse, bravoItem, w.otherTask, w.bravoTask]) {
    expect(body.includes(foreign), 'a foreign id in the email').toBe(false);
  }
  expect(await attemptsOf(otherClient)).toEqual([]);
  expect(await attemptsOf(someoneElse)).toEqual([]);
  expect((await attemptsOf(mine)).map((row) => row.state)).toEqual(['asked', 'accepted']);
  // In its own business, its own person's batch goes to them alone.
  expect(await batch(w.bravoPerson, w.bravo)).toMatchObject({ ok: true, items: 1 });
});

/** A live delegation: an agent acting for the world's recipient, which reads `otherTask` itself. */
async function delegatedAgent(): Promise<string> {
  return await w.db.app.withBusiness(w.alpha, async (tx) => {
    const [actor] = await tx.query<{ id: string }>(
      `select id from public.actors where business_id = $1 and person_id = $2 and kind = 'person'`,
      [tx.businessId, w.person],
    );
    const agent = await insertAgentActor(tx);
    await tx.query(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
       values ($1, gen_random_uuid(), $2, $3, $4, 'mail_crossing', array['task'], array['read'],
               $5, now() + interval '1 hour', 'record', $6)`,
      [tx.businessId, agent, w.person, actor?.id, 'b'.repeat(64), w.otherTask],
    );
    const granted = await issueGrant(tx, [], {
      subject: { kind: 'actor', id: agent },
      scope: { kind: 'record', id: w.otherTask },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: actor?.id ?? '',
    });
    if (!granted.ok) throw new Error('the agent grant was refused');
    return agent;
  });
}

it('AW-07b isolation (batch): one person to another under a live delegation, nothing crosses', async () => {
  await freshInbox();
  const sent = w.provider.outbox.length;
  await delegatedAgent();
  // Two people of one client, both reading the same task, the first with a live delegation.
  const mine = await itemFor(w.task, 'mention');
  const theirs = await clientItem(w.task, 'person', extra.clientA2);
  // What the agent can read lends its person nothing: an item on a task only the agent reads.
  const agentOnly = await itemFor(w.otherTask, 'assignment');
  expect(await batch(w.person)).toMatchObject({ ok: true, items: 1 });
  expect(w.provider.outbox.length).toBe(sent + 1);
  const toMe = w.provider.outbox.at(-1)?.body ?? '';
  expect(toMe.includes(w.canary), 'the recipient address').toBe(true);
  for (const foreign of [theirs, agentOnly, w.otherTask]) {
    expect(toMe.includes(foreign), 'a foreign id in the email').toBe(false);
  }
  expect((await attemptsOf(mine)).map((row) => row.state)).toEqual(['asked', 'accepted']);
  expect(await attemptsOf(theirs)).toEqual([]);
  expect(await attemptsOf(agentOnly)).toEqual([]);
  // The other person's own batch carries their item, to them, never the delegating person.
  expect(await batch(extra.clientA2)).toMatchObject({ ok: true, items: 1 });
  const toThem = w.provider.outbox.at(-1)?.body ?? '';
  expect(toThem.includes(w.canary.split('@')[0] ?? w.canary), 'the delegating person').toBe(false);
  expect(toThem.includes(mine), 'the item of the delegating person').toBe(false);
  expect((await attemptsOf(theirs)).map((row) => row.state)).toEqual(['asked', 'accepted']);
});
