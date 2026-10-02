// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 route recorded and C60 subscription in own session (LF-5), per client.
// AW-01's provider seam records every call's route, credential kind and the
// account that carried it, and lets a subscription carry only a person's own
// attended work in their own installation. Here each is checked on both sides
// of the client check: a task with no client records what carried it and
// meets the subscription rule by name; a client's task is refused before any
// route, so no route, kind or account is recorded for it, and a subscription
// is never reached, even in its own person's session.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { ModelCaller } from '../../packages/core-custody/src/index.ts';
import { callModel } from '../../packages/core-custody/src/index.ts';
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

useBrokerWorld('c60carry');

const SUBSCRIPTION = { ...CLOUD, credentialKind: 'subscription' as const };

/** Link the task to a client as `task.set_party` stores it, and read the slot back. */
async function forClient(work: Work): Promise<void> {
  const client = randomUUID();
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [work.taskId, client],
  );
  const [linked] = await s.db.admin.execute<{ client: string | null }>(
    'select uuid_7::text as client from public.records where id = $1',
    [work.taskId],
  );
  expect(linked?.client).toBe(client);
}

/** The person the run works for: its delegation's delegate. */
async function workForPerson(work: Work): Promise<string> {
  const [row] = await s.db.admin.execute<{ person: string }>(
    'select delegate_person_id::text as person from public.delegations where id = $1',
    [work.picked['delegationId']],
  );
  expect(row?.person).toBeTruthy();
  return String(row?.person);
}

/** A call by the agent, attended by `person` in their own session, or by nobody. */
async function callAs(work: Work, person: string | null, routes: (typeof CLOUD)[]) {
  await stepOf(work);
  const as: ModelCaller = { ...caller(work), attendedByPersonId: person };
  return await callModel(s.db.app, s.business, as, requestFor(work), withRoutes(routes));
}

/** What the call's rows recorded as carrying it. */
async function carried(callId: string | null | undefined) {
  const rows = await rowsOf(callId ?? null);
  return rows.map((row) => ({
    state: row['state'],
    route_key: row['route_key'],
    route_reach: row['route_reach'],
    credential_kind: row['credential_kind'],
    account: row['account'],
  }));
}

it('C60 route recorded: a task with no client records its route, credential kind and account', async () => {
  const work = await liveWork(s, 'c60 route no client', 2_000);
  const answer = await callAs(work, null, [CLOUD]);
  expect(answer).toMatchObject({ ok: true });
  expect(await carried(answer.ok ? answer.callId : null)).toEqual([
    {
      state: 'settled',
      route_key: 'replay',
      route_reach: 'cloud',
      credential_kind: 'api_key',
      account: 'replay-account-1',
    },
  ]);
}, 120_000);

const NOTHING_CARRIED = [
  { state: 'refused', route_key: null, route_reach: null, credential_kind: null, account: null },
];

it.each([
  ['a cloud key', [CLOUD]],
  ['a local model', [LOCAL]],
  ['a subscription', [SUBSCRIPTION]],
  ['all three', [LOCAL, CLOUD, SUBSCRIPTION]],
])(
  "C60 route recorded: a client's task offered %s records no route, kind or account",
  async (_offered, routes) => {
    const work = await liveWork(s, 'c60 route client', 2_000);
    await forClient(work);
    const seen = world.provider.seen.length;
    const answer = await callAs(work, await workForPerson(work), routes);
    expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(await carried(answer.ok ? null : answer.callId)).toEqual(NOTHING_CARRIED);
    expect(world.provider.seen.length).toBe(seen);
  },
  120_000,
);

it.each([
  ['unattended', (): string | null => null, [SUBSCRIPTION], 'SUBSCRIPTION_UNATTENDED'],
  [
    "in another person's session",
    (): string | null => randomUUID(),
    [SUBSCRIPTION],
    'SUBSCRIPTION_NOT_OWN_WORK',
  ],
  [
    "for another installation's tenant",
    (person: string): string | null => person,
    [{ ...SUBSCRIPTION, installation: 'there' }],
    'SUBSCRIPTION_OTHER_TENANT',
  ],
])(
  'C60 subscription in own session: with no client, a subscription %s is refused by name',
  async (_how, attendedBy, routes, code) => {
    const work = await liveWork(s, 'c60 subscription refused', 2_000);
    const seen = world.provider.seen.length;
    const answer = await callAs(work, attendedBy(await workForPerson(work)), routes);
    expect(answer).toMatchObject({ ok: false, code });
    expect(world.provider.seen.length).toBe(seen);
  },
  120_000,
);

it('C60 subscription in own session: with no client, its own person attending is carried', async () => {
  // The provider is asked once. What carried it is custody's credential under
  // the route's ref, and the row records that (a subscription is never stored,
  // so no call is carried by one yet); the rule ran on the route's own kind.
  const own = await liveWork(s, 'c60 subscription own', 2_000);
  const before = world.provider.seen.length;
  const answer = await callAs(own, await workForPerson(own), [SUBSCRIPTION]);
  expect(answer).toMatchObject({ ok: true });
  expect(world.provider.seen.length).toBe(before + 1);
  expect(await carried(answer.ok ? answer.callId : null)).toMatchObject([
    { state: 'settled', route_key: 'replay' },
  ]);
}, 120_000);

// Unattended, a subscription checked first would say SUBSCRIPTION_UNATTENDED;
// attended by its own person, it would pass and record the route. Either way
// the client's refusal comes first, as the call's step, with nothing carried.
it.each([
  ['unattended', false],
  ["in its own person's session", true],
])(
  "C60 subscription in own session: a client's task is refused before the subscription, %s",
  async (_how, attending) => {
    const work = await liveWork(s, 'c60 subscription client', 2_000);
    await forClient(work);
    const seen = world.provider.seen.length;
    const answer = await callAs(work, attending ? await workForPerson(work) : null, [SUBSCRIPTION]);
    expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(await carried(answer.ok ? null : answer.callId)).toEqual(NOTHING_CARRIED);
    expect(world.provider.seen.length).toBe(seen);
  },
  120_000,
);
