// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 at the handoff: a subscription send is judged again in a
// transaction custody waits on, with the task held, so a client linked to the
// task, or a client contact's write on it, landing after the start but before
// the handoff sends nothing; one landing after the handoff's judgement waits
// until custody has the request.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  callModel,
  type Broker,
  type BrokerRoute,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('line72handoff');

const SEAT: BrokerRoute = { ...CLOUD, key: 'owners_seat', credentialKind: 'subscription' };

const linkClient = async (work: Work): Promise<void> => {
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [work.taskId, randomUUID()],
  );
};

const contactWrites = async (work: Work): Promise<void> => {
  const actorId = await s.db.app.withBusiness(s.business, async (tx) => {
    const personId = await insertPerson(tx, 'Client contact');
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key, active)
       values ($1, $2, $3, 'client_contact', true)`,
      [tx.businessId, randomUUID(), personId],
    );
    return await insertActor(tx, personId);
  });
  await s.db.admin.execute(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`,
    [s.business, randomUUID(), `handoff-${randomUUID()}`, actorId, '0'.repeat(64), work.taskId],
  );
};

/** Custody as the world has it, with `before` run once the start has committed and `admitted` once custody's judgement admits. */
function around(
  before: () => Promise<void>,
  admitted: () => Promise<void> = async () => {},
): Broker {
  const custody: Custody = {
    ...world.custody,
    dispatch: async (credentialRef, request, onPiece, admit, handoff) => {
      await before();
      const judged =
        admit === undefined
          ? undefined
          : async () => {
              const admission = await admit();
              if (admission !== undefined) await admitted();
              return admission;
            };
      return await world.custody.dispatch(credentialRef, request, onPiece, judged, handoff);
    },
  };
  return { ...withRoutes([SEAT]), custody };
}

/** The world's person holding `role` from now on: their membership ends and a new one starts. */
async function holding(role: 'owner' | 'member'): Promise<void> {
  await s.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [s.business, s.decider.personId],
  );
  await s.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [s.business, randomUUID(), s.decider.personId, role],
  );
}

async function ownersWork(): Promise<Work> {
  await holding('owner');
  const work = await liveWork(s, `handoff ${randomUUID()}`, 2_000);
  await stepOf(work);
  return work;
}

async function ask(work: Work, broker: Broker) {
  const [row] = await s.db.admin.execute<{ person: string }>(
    'select delegate_person_id::text as person from public.delegations where id = $1',
    [work.picked['delegationId']],
  );
  const as = { ...caller(work), attendedByPersonId: String(row?.person) };
  const fields = [{ name: 'instruction', from: { recordId: work.taskId, key: 'title' } }];
  return await callModel(s.db.app, s.business, as, requestFor(work, { fields }), broker);
}

it.each([
  ['a client linked to the task', linkClient],
  ["a client contact's write on the task", contactWrites],
])(
  '%s after the start and before the handoff sends nothing',
  async (_what, lands) => {
    const work = await ownersWork();
    const seen = world.provider.seen.length;
    const answer = await ask(
      work,
      around(async () => await lands(work)),
    );
    expect(answer).toMatchObject({ ok: false });
    expect(world.provider.seen.length).toBe(seen);
  },
  120_000,
);

it("a client link issued after the handoff's judgement waits until custody has the request", async () => {
  const work = await ownersWork();
  const seen = world.provider.seen.length;
  let linking: Promise<void> | undefined;
  let linked = false;
  let linkedWhileHeld = true;
  const broker = around(
    async () => {},
    async () => {
      linking = (async () => {
        await linkClient(work);
        linked = true;
      })();
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      linkedWhileHeld = linked;
    },
  );
  const answer = await ask(work, broker);
  await linking;
  expect(linkedWhileHeld).toBe(false);
  expect(answer).toMatchObject({ ok: true });
  expect(world.provider.seen.length).toBe(seen + 1);
  expect(linked).toBe(true);
}, 120_000);

it('a send no client touches is admitted at the handoff and carried', async () => {
  const work = await ownersWork();
  const seen = world.provider.seen.length;
  expect(
    await ask(
      work,
      around(async () => {}),
    ),
  ).toMatchObject({ ok: true });
  expect(world.provider.seen.length).toBe(seen + 1);
}, 120_000);
