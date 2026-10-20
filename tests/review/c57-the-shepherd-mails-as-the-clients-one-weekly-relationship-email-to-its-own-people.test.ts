// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each recipient beside the reason it is in or out */
//
// C57 (#2017): the shepherd's email is automation's mail to a client, `relationship`, the one a
// week each client gets across every source (`email-class.ts`), and it goes only to the review's
// own client's people: each reads the task through a live party-scoped `task:read` grant on that
// client, is not the business's staff, and has a confirmed address.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { clientHere } from '../reads/client-rows.ts';
import {
  approved,
  attemptsOf,
  clientPerson,
  confirmAddress,
  inSide,
  itemOf,
  itemRecipients,
  noDatabase,
  on,
  raisedOf,
  raisedScene,
  revokeGrantOf,
  runOf,
  scene,
  send,
  shepherd,
  staffDecider,
  useShepherdWorld,
  w,
  workerCommentItem,
} from './shepherd-world.ts';

useShepherdWorld('c57class');

describe.skipIf(noDatabase)(
  'C57 the shepherd mails as the relationship class to its own client',
  () => {
    it("C57 relationship class: the sent item's asked evidence carries class:relationship", async () => {
      const { scene: s, raised } = await raisedScene();
      await approved('alpha', raised);
      const item = await itemOf(raised, s.recipient.personId);
      expect(await send('alpha', item)).toMatchObject({ ok: true, state: 'accepted' });
      expect(await attemptsOf(item)).toStrictEqual([
        { state: 'asked', evidence: 'class:relationship' },
        { state: 'accepted', evidence: expect.stringMatching(/^provider:/u) },
      ]);
    });

    it('C57 relationship class: a second relationship email to the same client that week is CLIENT_CAP_SPENT', async () => {
      const { scene: s, raised } = await raisedScene();
      await approved('alpha', raised);
      expect(await send('alpha', await itemOf(raised, s.recipient.personId))).toMatchObject({
        ok: true,
      });
      // The next week's walk-through, come early: the same review under another occurrence.
      const again = raisedOf(await shepherd(await runOf(), s.review));
      await approved('alpha', again);
      const before = w.provider.received.length;
      const second = await itemOf(again, s.recipient.personId);
      expect(await send('alpha', second)).toStrictEqual({ ok: false, code: 'CLIENT_CAP_SPENT' });
      expect(w.provider.received.length).toBe(before);
      expect(await attemptsOf(second)).toStrictEqual([]);
    });

    it("C57 relationship class: the shepherd's own email is CLIENT_CAP_SPENT when the client's week is spent", async () => {
      const s = await scene();
      // A worker's client comment, sent first, spends the client's week.
      const earlier = await workerCommentItem('alpha', s.task, s.recipient.personId);
      expect(await send('alpha', earlier)).toMatchObject({ ok: true, state: 'accepted' });
      const raised = raisedOf(await shepherd(await runOf(), s.review));
      await approved('alpha', raised);
      const before = w.provider.received.length;
      const item = await itemOf(raised, s.recipient.personId);
      expect(await send('alpha', item)).toStrictEqual({ ok: false, code: 'CLIENT_CAP_SPENT' });
      expect(w.provider.received.length).toBe(before);
      expect(await attemptsOf(item)).toStrictEqual([]);
    });

    it('C57 recipients of its own client: only its own client people with a live grant and an address get an item', async () => {
      const s = await scene();
      // The business's staff: the decider reads every task and has an address; another member
      // holds read on this very client. Neither is the client's.
      await inSide('alpha', async (tx) => {
        await confirmAddress(tx, on('alpha').decider.personId, `staff-${randomUUID()}@agency.test`);
      });
      const member = await staffDecider('alpha', { kind: 'business', id: null });
      await inSide('alpha', async (tx) => {
        await confirmAddress(tx, member.personId, `member-${randomUUID()}@agency.test`);
      });
      await inSide('alpha', async (tx) => {
        const granted = await issueGrant(tx, [], {
          subject: { kind: 'person', id: member.personId },
          scope: { kind: 'party', id: s.client },
          collection: 'task',
          action: 'read',
          parentGrantId: null,
          grantedByActorId: on('alpha').decider.actorId,
        });
        if (!granted.ok) throw new Error('the member grant was refused');
      });
      // A person of another client in the same business.
      const otherClient = await clientHere(w.db.admin, on('alpha').business, randomUUID());
      const otherClients = await clientPerson('alpha', otherClient);
      // The client's people whose grant was revoked, who have no address, or who hold no grant.
      const revoked = await clientPerson('alpha', s.client);
      await revokeGrantOf('alpha', revoked.grantId ?? '');
      const noAddress = await clientPerson('alpha', s.client, { address: null });
      const noGrant = await clientPerson('alpha', s.client, { granted: false });
      // A second of the client's own people does get one.
      const second = await clientPerson('alpha', s.client);

      const raised = raisedOf(await shepherd(await runOf(), s.review));
      const expected = [s.recipient.personId, second.personId].toSorted();
      expect(raised.recipients).toBe(2);
      expect(await itemRecipients(raised.commentId)).toStrictEqual(expected);
      const [row] = await w.db.admin.execute<{ readonly people: string[] }>(
        `select recipient_person_ids::text[] as people from public.review_shepherd_sends
        where id = $1`,
        [raised.sendId],
      );
      expect(row?.people.toSorted()).toStrictEqual(expected);
      for (const outsider of [
        on('alpha').decider.personId,
        member.personId,
        otherClients.personId,
        revoked.personId,
        noAddress.personId,
        noGrant.personId,
      ]) {
        expect(expected).not.toContain(outsider);
      }
    });

    it('C57 recipients of its own client: a review whose client has no reader of its own is no_recipients', async () => {
      const s = await scene();
      await revokeGrantOf('alpha', s.recipient.grantId ?? '');
      expect(await shepherd(await runOf(), s.review)).toStrictEqual({ kind: 'no_recipients' });
      const [row] = await w.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.review_shepherd_sends where review_id = $1',
        [s.review],
      );
      expect(row?.n).toBe('0');
    });
  },
);
