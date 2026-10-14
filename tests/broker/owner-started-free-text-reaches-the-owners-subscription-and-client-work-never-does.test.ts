// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72, by source, through the real broker and custody: a task's free
// text goes to the owner's own subscription only when the owner started the
// task, it has no client and nothing a client typed is on it. The admitted
// call records `subscription`. The same text on a task with a client is
// refused by name before any route, and every other source keeps today's
// local-only handling.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  callModel,
  type BrokerRoute,
  type ModelCallField,
} from '../../packages/core-custody/src/index.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  LOCAL,
  caller,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('line72source');

const SEAT: BrokerRoute = { ...CLOUD, key: 'owners_seat', credentialKind: 'subscription' };

/** The task's text as the operation's free-text field, bound to the run's own task. */
const freeText = (work: Work): readonly ModelCallField[] => [
  { name: 'instruction', from: { recordId: work.taskId, key: 'title' } },
];

/** The world's person, who creates every task here, holding `role` from now on. */
async function holdsRole(role: 'owner' | 'member'): Promise<void> {
  await movesTo(s.decider.personId, role);
}

/** A role change as the product makes one: the membership ends and a new one starts. */
async function movesTo(personId: string, role: string): Promise<void> {
  await s.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [s.business, personId],
  );
  await s.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [s.business, randomUUID(), personId, role],
  );
}

/** The person the run works for, attending in their own session. */
async function workFor(work: Work): Promise<string> {
  const [row] = await s.db.admin.execute<{ person: string }>(
    'select delegate_person_id::text as person from public.delegations where id = $1',
    [work.picked['delegationId']],
  );
  return String(row?.person);
}

async function ask(work: Work, routes: readonly BrokerRoute[]) {
  await stepOf(work);
  const as = { ...caller(work), attendedByPersonId: await workFor(work) };
  const request = requestFor(work, { fields: freeText(work) });
  return await callModel(s.db.app, s.business, as, request, withRoutes(routes));
}

/** An owner-started task with no client, live and picked up. */
async function ownersWork(title: string): Promise<Work> {
  await holdsRole('owner');
  return await liveWork(s, title, 2_000);
}

async function forClient(work: Work): Promise<void> {
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [work.taskId, randomUUID()],
  );
}

/** An applied write on the task by `actorId`, as the register records one. */
async function wrote(work: Work, actorId: string): Promise<void> {
  await s.db.admin.execute(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`,
    [s.business, randomUUID(), `line72-${randomUUID()}`, actorId, '0'.repeat(64), work.taskId],
  );
}

/** A person of the business with no staff role: a client's contact. */
async function clientPerson(): Promise<{ readonly personId: string; readonly actorId: string }> {
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const personId = await insertPerson(tx, 'Client contact');
    const actorId = await insertActor(tx, personId);
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key, active)
       values ($1, $2, $3, 'client_contact', true)`,
      [tx.businessId, randomUUID(), personId],
    );
    return { personId, actorId };
  });
}

async function carried(callId: string | null) {
  const rows = await rowsOf(callId);
  return rows.map((row) => ({
    state: row['state'],
    route_key: row['route_key'],
    route_reach: row['route_reach'],
    credential_kind: row['credential_kind'],
    refusal_code: row['refusal_code'],
  }));
}

it("an owner-started task with no client sends its free text to the owner's subscription, recorded as one", async () => {
  const work = await ownersWork(`About page fix ${randomUUID()}`);
  const seen = world.provider.seen.length;
  const answer = await ask(work, [CLOUD, SEAT]);
  expect(answer).toMatchObject({ ok: true });
  expect(await carried(answer.callId)).toEqual([
    {
      state: 'settled',
      route_key: 'owners_seat',
      route_reach: 'cloud',
      credential_kind: 'subscription',
      refusal_code: null,
    },
  ]);
  expect(world.provider.seen.length).toBe(seen + 1);
}, 120_000);

it("the owner's free text never takes an API key", async () => {
  const work = await ownersWork('owner text, key only');
  const answer = await ask(work, [CLOUD]);
  expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
}, 120_000);

it.each([
  ['a subscription', [SEAT]],
  ['a subscription beside a local model and a key', [LOCAL, CLOUD, SEAT]],
])(
  'the same text on a task with a client, offered %s, is refused by name with nothing sent',
  async (_offered, routes) => {
    const work = await ownersWork('owner text, client task');
    await forClient(work);
    const seen = world.provider.seen.length;
    const answer = await ask(work, routes);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' });
    expect(await carried(answer.callId)).toEqual([
      {
        state: 'refused',
        route_key: null,
        route_reach: null,
        credential_kind: null,
        refusal_code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
      },
    ]);
    expect(world.provider.seen.length).toBe(seen);
  },
  120_000,
);

it("a task with a client offered no subscription keeps C60's refusal", async () => {
  const work = await ownersWork('owner text, client task, no seat');
  await forClient(work);
  const answer = await ask(work, [LOCAL, CLOUD]);
  expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
}, 120_000);

/** The call on `[SEAT]` refused as waiting on a local model, with nothing sent, and local still served. */
async function staysLocal(work: Work): Promise<void> {
  const seen = world.provider.seen.length;
  expect(await ask(work, [SEAT])).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
  expect(world.provider.seen.length).toBe(seen);
  const local = await ask(work, [SEAT, LOCAL]);
  expect(local).toMatchObject({ ok: true });
  expect(await carried(local.callId)).toMatchObject([{ route_reach: 'local' }]);
}

it.each([
  [
    'a client contact typed on it',
    async (work: Work) => await wrote(work, (await clientPerson()).actorId),
  ],
  [
    'a client contact who has since joined the staff typed on it',
    async (work: Work) => {
      const contact = await clientPerson();
      await wrote(work, contact.actorId);
      await movesTo(contact.personId, 'member');
    },
  ],
  ['an agent wrote a summary onto it', async (work: Work) => await wrote(work, s.agentActorId)],
])(
  'a task %s keeps its free text off the subscription',
  async (_how, touch) => {
    const work = await ownersWork('owner text, touched');
    await touch(work);
    await staysLocal(work);
  },
  120_000,
);

it('a task a client contact typed on keeps even its business-internal fields off every cloud route', async () => {
  const work = await ownersWork('owner text, client typed, tone');
  await wrote(work, (await clientPerson()).actorId);
  await stepOf(work);
  const seen = world.provider.seen.length;
  const answer = await callModel(
    s.db.app,
    s.business,
    caller(work),
    requestFor(work),
    withRoutes([CLOUD]),
  );
  expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it("a task staff started keeps its free text off the owner's subscription", async () => {
  await holdsRole('member');
  const work = await liveWork(s, 'staff text', 2_000);
  await staysLocal(work);
}, 120_000);

it('a task staff started stays theirs after its creator becomes the owner', async () => {
  await holdsRole('member');
  const work = await liveWork(s, 'staff text, then owner', 2_000);
  await holdsRole('owner');
  await staysLocal(work);
}, 120_000);

it("an owner's task stays the owner's after they step down", async () => {
  const work = await ownersWork('owner text, then staff');
  await holdsRole('member');
  const seen = world.provider.seen.length;
  const answer = await ask(work, [SEAT]);
  expect(answer).toMatchObject({ ok: true });
  expect(await carried(answer.callId)).toMatchObject([{ credential_kind: 'subscription' }]);
  expect(world.provider.seen.length).toBe(seen + 1);
}, 120_000);
