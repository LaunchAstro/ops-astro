// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each way a send stands or is refused, read top to bottom */
//
// C57 (#2017): the shepherd raises its comment and items under its run's lease, and the broker
// sends one of those items only while the send stands: a person approved its exact digest, or a
// live standing mandate covers the shepherd's class for the review's client and no live mandate
// refuses it, and the occurrence's activation is still on with its standing approval unrevoked.
// Anything else is refused at the send, `SEND_NOT_APPROVED`, before any attempt row or provider
// call. Each case uses a client of its own, so one client's weekly relationship mail never
// stands in for a refusal.

import { describe, expect, it } from 'vitest';
import {
  approveAs,
  attemptsOf,
  commentOn,
  footprint,
  itemOf,
  mandate,
  mandateEnding,
  noDatabase,
  on,
  raisedScene,
  revokeMandateOf,
  revokeStanding,
  runOf,
  scene,
  send,
  shepherd,
  turnOff,
  useShepherdWorld,
  w,
  type Scene,
} from './shepherd-world.ts';

useShepherdWorld('c57send');

/** The provider's request count around one send. */
async function sentAround<T>(work: () => Promise<T>): Promise<{ result: T; received: number }> {
  const before = w.provider.received.length;
  const result = await work();
  return { result, received: w.provider.received.length - before };
}

/** The send refused before any write: no attempt row, nothing reached the provider. */
async function refusedAtSend(item: string): Promise<void> {
  const { result, received } = await sentAround(async () => await send('alpha', item));
  expect(result).toStrictEqual({ ok: false, code: 'SEND_NOT_APPROVED' });
  expect(received).toBe(0);
  expect(await attemptsOf(item)).toStrictEqual([]);
}

/** The send went: accepted, one request at the provider. */
async function sentOnce(item: string): Promise<void> {
  const { result, received } = await sentAround(async () => await send('alpha', item));
  expect(result).toMatchObject({ ok: true, state: 'accepted' });
  expect(received).toBe(1);
}

/** A decided change request on the scene's review: refused, or approved with its task made. */
async function decidedRequest(
  s: Scene,
  state: 'approved' | 'refused',
  createdTask: string | null,
): Promise<void> {
  const pin = await commentOn('alpha', s.task, `Client pin ${s.marker}`, s.recipient.actorId);
  const decider = on('alpha').decider;
  await w.db.admin.execute(
    `insert into public.review_change_requests
       (business_id, id, review_id, comment_id, task_id, party_id, request_text, state,
        proposed_by_actor_id, proposed_by_person_id, decided_by_actor_id, decided_by_person_id,
        decided_at, created_task_id)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, 'Decided already', $6, $7, $8, $7, $8, now(),
             $9)`,
    [
      on('alpha').business,
      s.review,
      pin,
      s.task,
      s.client,
      state,
      decider.actorId,
      decider.personId,
      createdTask,
    ],
  );
}

describe.skipIf(noDatabase)(
  'C57 a shepherd send leaves only under a mandate or an approval',
  () => {
    it('C57 unapproved effect refused: a raised item with no approval and no mandate sends nothing', async () => {
      const { scene: s, raised } = await raisedScene();
      expect(raised).toMatchObject({ kind: 'raised', recipients: 1, replayed: false });
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it("C57 unapproved effect refused: a person's approval of the exact digest lets it send", async () => {
      const { scene: s, raised } = await raisedScene();
      const answer = await approveAs('alpha', on('alpha').decider, {
        sendId: raised.sendId,
        digest: raised.digest,
      });
      expect(answer).toStrictEqual({ ok: true, id: raised.sendId, digest: raised.digest });
      await sentOnce(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: an approval of a stale digest is refused and still nothing sends', async () => {
      const { scene: s, raised } = await raisedScene();
      const stale = await approveAs('alpha', on('alpha').decider, {
        sendId: raised.sendId,
        digest: 'f'.repeat(64),
      });
      expect(stale).toStrictEqual({ ok: false, code: 'SHEPHERD_DIGEST_STALE' });
      const [row] = await w.db.admin.execute<{ readonly approved: string | null }>(
        'select approved_digest as approved from public.review_shepherd_sends where id = $1',
        [raised.sendId],
      );
      expect(row?.approved).toBeNull();
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: a live covering mandate lets it send', async () => {
      const { scene: s, raised } = await raisedScene();
      await mandate('alpha', s.client);
      await sentOnce(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: a live mandate refusal beside a covering mandate refuses', async () => {
      const { scene: s, raised } = await raisedScene();
      await mandate('alpha', s.client);
      await mandate('alpha', s.client, true);
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: a mandate revoked after the raise refuses at send', async () => {
      const { scene: s, raised } = await raisedScene();
      const id = await mandate('alpha', s.client);
      await revokeMandateOf('alpha', id);
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: a mandate expired after the raise refuses at send', async () => {
      const s = await scene();
      await mandateEnding('alpha', s.client, 2);
      const run = await runOf();
      const raised = await shepherd(run, s.review);
      expect(raised.kind).toBe('raised');
      if (raised.kind !== 'raised') return;
      await new Promise((resolve) => {
        setTimeout(resolve, 2_500);
      });
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: the standing approval revoked after an approval refuses', async () => {
      const { scene: s, run, raised } = await raisedScene();
      await approveAs('alpha', on('alpha').decider, {
        sendId: raised.sendId,
        digest: raised.digest,
      });
      await revokeStanding(run);
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: the activation turned off after an approval refuses', async () => {
      const { scene: s, run, raised } = await raisedScene();
      await approveAs('alpha', on('alpha').decider, {
        sendId: raised.sendId,
        digest: raised.digest,
      });
      await turnOff(run);
      await refusedAtSend(await itemOf(raised, s.recipient.personId));
    });

    it('C57 unapproved effect refused: no open request is nothing_pending and writes nothing', async () => {
      const s = await scene('alpha', { open: 0 });
      // An approved request whose task was made is no longer open; a refused one never was.
      await decidedRequest(s, 'refused', null);
      await decidedRequest(
        s,
        'approved',
        await commentOn('alpha', s.task, 'made', s.recipient.actorId),
      );
      const run = await runOf();
      const before = await footprint();
      expect(await shepherd(run, s.review)).toStrictEqual({ kind: 'nothing_pending' });
      expect(await footprint()).toStrictEqual(before);
    });
  },
);
