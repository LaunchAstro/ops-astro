// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Model egress off for the map's client: no model call is
// made." A research ticket's run calls a model through the broker (AW-01),
// which reads the run's task's client link and refuses a client's task before
// any route (C60). The ticket's link is wayfinder's: `map.scope` puts the
// map's client on the map and on every ticket under it, and a ticket filed
// under a scoped map inherits it. These cases hold that seam end to end, on
// the real commands and the real broker.
//
// The run is main's proposal, approval and pickup on the ticket; `run started
// (research)` under `run:write` is SL12-B's U37 and stays in wf-7-held, as do
// the map's research ceiling and the waiting item.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asPerson,
  approve,
  freshPurpose,
  pickup,
  propose,
  revisionOf,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  call,
  noDatabase,
  rowsOf,
  s,
  useBrokerWorld,
  withRoutes,
  world,
} from '../broker/broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('wf7egress');

const chartMap = async (title: string): Promise<{ map: string; ticket: string }> => {
  const outcome = await asPerson(s, {
    command: 'map.chart',
    operationId: randomUUID(),
    title,
    tickets: [{ ref: 'r1', title: `${title}: what is decided`, type: 'research' }],
  });
  const tickets = appliedDetail(outcome, 'map.chart')['tickets'] as Record<string, string>;
  return { map: String((outcome as { recordId: string }).recordId), ticket: String(tickets['r1']) };
};

const scope = async (map: string, client: string | null): Promise<void> => {
  appliedDetail(
    await asPerson(s, {
      command: 'map.scope',
      operationId: randomUUID(),
      recordId: map,
      expectedRevision: await revisionOf(s, map),
      client,
    }),
    'map.scope',
  );
};

const researchTicket = async (map: string, title: string): Promise<string> => {
  const outcome = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
    parentId: map,
  });
  appliedDetail(outcome, 'task.create');
  return String((outcome as { recordId: string }).recordId);
};

/** The run on the ticket: proposed, approved and picked up by the agent. */
const runOn = async (ticket: string): Promise<Work> => {
  const proposal = await propose(s, ticket, { maximumMinor: 2_000, purpose: freshPurpose() });
  const decision = await approve(s, proposal);
  const picked = await pickup(s, decision['reservationId']);
  return { taskId: ticket, proposal, decision, picked };
};

const linkOf = async (id: string): Promise<string | null> =>
  (
    await s.db.admin.execute<{ client: string | null }>(
      'select uuid_7::text as client from public.records where id = $1',
      [id],
    )
  )[0]?.client ?? null;

/** Refused as its step before any route, and the provider asked nothing. */
async function expectNoCall(work: Work): Promise<void> {
  const seen = world.provider.seen.length;
  const answer = await call(work, {}, withRoutes([CLOUD]));
  expect(answer).toMatchObject({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
  expect(await rowsOf(answer.ok ? null : (answer.callId ?? null))).toMatchObject([
    { state: 'refused', refusal_code: 'CLIENT_MODEL_USE_OFF', route_key: null },
  ]);
  expect(world.provider.seen.length).toBe(seen);
}

it('WF-7 egress off makes no call: a research ticket on a map scoped to a client after charting', async () => {
  const { map, ticket } = await chartMap('wf7 scoped after');
  const client = randomUUID();
  await scope(map, client);
  expect(await linkOf(ticket)).toBe(client);
  await expectNoCall(await runOn(ticket));
}, 180_000);

it('WF-7 egress off makes no call: a research ticket filed under a map already scoped to a client', async () => {
  const { map } = await chartMap('wf7 scoped before');
  const client = randomUUID();
  await scope(map, client);
  const ticket = await researchTicket(map, 'wf7 filed after the scope');
  expect(await linkOf(ticket)).toBe(client);
  await expectNoCall(await runOn(ticket));
}, 180_000);

it('WF-7 egress off makes no call: a map whose client is cleared lets its research ticket call', async () => {
  const { map, ticket } = await chartMap('wf7 scope cleared');
  await scope(map, randomUUID());
  await scope(map, null);
  expect(await linkOf(ticket)).toBeNull();
  const answer = await call(await runOn(ticket), {}, withRoutes([CLOUD]));
  expect(answer).toMatchObject({ ok: true });
}, 180_000);
