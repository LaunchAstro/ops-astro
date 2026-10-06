// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one shared world and its three readers */
//
// A read grant on a map covers its tickets (W12) in every read that asks
// access in its own statement (`readableNow`): the inbox email's check and
// `trace.read`, as in `task.read`. A reader shown the client view still reads
// no map ticket (WF-1), whatever grant reaches it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogue, EMAIL_SEND, emailAdapter } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, type Broker } from '../../packages/core-custody/src/index.ts';
import { readableNow } from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { MAIL } from '../broker/email-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type WayfinderWorld,
} from './world.ts';

function mailProbe(): { broker: Broker; dispatched: string[] } {
  const dispatched: string[] = [];
  return {
    dispatched,
    broker: {
      custody: {
        pid: 0,
        dispatch: (ref) => {
          dispatched.push(ref);
          return Promise.resolve({ kind: 'refused', started: false, code: 'NOT_SENT_IN_TEST' });
        },
        stderr: () => '',
        describe: () => Promise.resolve(null),
        raw: () => Promise.resolve({}),
        kill: () => {},
        stop: () => Promise.resolve(),
      },
      operations: catalogue([EMAIL_SEND]),
      providers: new Map([['resend', { build: emailAdapter, price: () => 0 }]]),
      routes: [
        {
          key: 'email',
          reach: 'cloud',
          provider: 'resend',
          credentialRef: 'test_key',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 4,
        },
      ],
      installation: 'here',
      audit: () => Promise.resolve(),
    },
  };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a map read grant reaches its tickets in the email check and the trace read',
  () => {
    let w: WayfinderWorld;
    let owner: Decider;
    let map: Made;
    let ticket: Made;

    beforeAll(async () => {
      w = await wayfinderWorld('mapthrough', 'mapthrough');
      owner = await w.decider('owner');
      await w.grant(owner, 'assign');
      map = await w.create(owner, { title: 'read-through map' }, { taskType: 'map' });
      ticket = await w.create(owner, { title: 'read-through ticket' }, { parentId: map.id });
    });
    afterAll(async () => {
      await w?.drop();
    });

    async function asRole(member: Member, role: string): Promise<void> {
      await w.db.admin.execute(
        'update public.memberships set role_key = $3 where business_id = $1 and person_id = $2',
        [w.business, member.personId, role],
      );
    }

    async function readable(member: Member, recordId: string): Promise<boolean | undefined> {
      return await w.db.app.withBusiness(w.business, async (tx) => {
        const [row] = await tx.query<{ readable: boolean }>(
          `select ${readableNow('$3::uuid', "'infinity'")} as readable
             from public.records r where r.business_id = $1 and r.id = $2`,
          [w.business, recordId, member.personId],
        );
        return row?.readable;
      });
    }

    it('emails a map-only assignee about their ticket assignment', async () => {
      const assignee = await w.member('map-only-mail', ['read'], { kind: 'record', id: map.id });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { assignee: assignee.personId },
        }),
        'assign the ticket',
      );
      const [item] = await w.db.admin.execute<{ id: string }>(
        `select id from public.inbox_items where business_id = $1 and recipient_person_id = $2
           and subject_record_id = $3 and reason = 'assignment' and work_state = 'open'`,
        [w.business, assignee.personId, ticket.id],
      );
      if (item === undefined) throw new Error('assignment item missing');
      await w.db.admin.execute(
        `insert into public.person_identifiers
          (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
         values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
        [w.business, assignee.personId, 'synthetic-map-assignee@example.test'],
      );
      const { broker, dispatched } = mailProbe();
      const sent = await sendInboxEmail(w.db.app, w.business, item.id, broker, MAIL);
      expect(sent).not.toMatchObject({ code: 'ITEM_WITHHELD' });
      expect(dispatched).toHaveLength(1);
    });

    it('serves an operator the trace of a ticket they read only through its map', async () => {
      const operator = await w.member('map-only-operator', ['read'], {
        kind: 'record',
        id: map.id,
      });
      await w.db.app.withBusiness(w.business, async (tx) => {
        await grantTo(tx, operator, 'read', undefined, false, 'operations');
      });
      await asRole(operator, 'admin');
      const plain = await w.create(owner, { title: 'outside the map' });
      expect(await w.read(operator, { read: 'trace.read', recordId: ticket.id })).toMatchObject({
        ok: true,
        trace: { taskId: ticket.id },
      });
      expect(codeOf(await w.read(operator, { read: 'trace.read', recordId: plain.id }))).toBe(
        'NOT_FOUND',
      );
    });

    it('still withholds a map ticket from a client reader whose grant reaches it', async () => {
      const onTicket = await w.member('client-on-ticket', ['read'], {
        kind: 'record',
        id: ticket.id,
      });
      const onMap = await w.member('client-on-map', ['read'], { kind: 'record', id: map.id });
      await asRole(onTicket, 'client');
      await asRole(onMap, 'client');
      expect(await readable(onTicket, ticket.id)).toBe(false);
      expect(await readable(onMap, ticket.id)).toBe(false);
    });
  },
);
