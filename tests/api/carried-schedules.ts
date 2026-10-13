// SPDX-License-Identifier: AGPL-3.0-only
//
// What the carried-call schedules share: the person's question sent as the
// side panel sends it, the durable rows a case asserts on, the changes that
// withdraw a call's authority, and a hold on the agent's actor row that stops
// a carriage judgement at its lock (a judgement reads the actor `for share`;
// the call's own writes only take its key, so they pass the hold).

import { revokeGrant, type TenantQuery } from '../../packages/core-records/src/index.ts';
import type { CarriedWorld } from './carried-world.ts';
import { holdApp, waitersOf, type HeldApp } from './carried-exchange-fixture.ts';
import { sendStreaming, type Streaming } from './streamed-reply-fixture.ts';

export interface CallRows {
  readonly state: string;
  readonly offered: boolean;
  readonly requested: boolean;
  readonly actual: number | null;
}

/** A new conversation's first question, as a stream; not awaited, so a case can act meanwhile. */
export const ask = (
  world: CarriedWorld,
  body: string,
  token?: string,
  task?: string,
): Promise<Streaming> =>
  sendStreaming(
    world.api,
    world.w.owner,
    'conversation.start',
    { body, ...(task === undefined ? {} : { scope: { kind: 'task', id: task } }) },
    token,
  );

/** The agent's membership of call `k`'s conversation closed, as a model change closes it. */
export async function leaveMembership(tx: TenantQuery, k: string): Promise<void> {
  await tx.query(
    `update public.conversation_agent_members m set left_at = clock_timestamp()
       from public.model_calls c
      where c.business_id = $1 and c.id = $2 and m.business_id = c.business_id
        and m.conversation_id = c.conversation_id and m.left_at is null`,
    [tx.businessId, k],
  );
}

/** The one call asked with `body`, and what its carriers row proves. */
export async function callFor(world: CarriedWorld, body: string): Promise<readonly CallRows[]> {
  return await world.w.fixture.db.admin.execute<CallRows>(
    `select c.state, k.offered_at is not null as offered, k.request_at is not null as requested,
            c.actual_minor::int as actual
       from public.model_calls c
       join public.conversation_messages m
         on m.business_id = c.business_id and m.id = c.conversation_message_id
       left join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      where m.body = $1`,
    [body],
  );
}

/** Every ring of the agent's doorbell stored, and anything stored on a call's line. */
export async function stored(world: CarriedWorld): Promise<readonly { readonly topic: string }[]> {
  return await world.w.fixture.db.admin.execute<{ readonly topic: string }>(
    `select topic from realtime.messages order by inserted_at`,
  );
}

/** Agent replies kept for the question `body`. */
export async function repliesTo(world: CarriedWorld, body: string): Promise<number> {
  return await world.w.count(
    `select count(*)::text as n from public.conversation_messages a
       join public.conversation_messages q on q.id = a.answers_message_id
      where q.body = $1`,
    [body],
  );
}

/** The owner's own-conversation grant revoked, in `tx`. */
export async function revokeOwn(world: CarriedWorld, tx: TenantQuery): Promise<void> {
  const grants = await tx.query<{ readonly id: string }>(
    `select id from public.grants
      where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null`,
    [world.w.owner.personId],
  );
  for (const grant of grants) {
    // oxlint-disable-next-line no-await-in-loop -- one revocation after another, in one transaction
    await revokeGrant(tx, grant.id);
  }
}

/** The agent deactivated, in `tx`, as the operator's script does. */
export async function deactivateAgent(world: CarriedWorld, tx: TenantQuery): Promise<void> {
  await tx.query(
    `update public.actors set active = false, deactivated_at = clock_timestamp()
      where business_id = $1 and id = $2`,
    [tx.businessId, world.carrier.agent],
  );
}

/** The agent's actor row held so a carriage judgement waits on it; `letGo` commits what the case adds. */
export async function holdAgent(world: CarriedWorld): Promise<HeldApp<void>> {
  const { fixture } = world.w;
  return await holdApp(fixture.db.appUrl, fixture.business, async (tx) => {
    await tx.query(
      `select 1 from public.actors where business_id = $1 and id = $2 for no key update`,
      [tx.businessId, world.carrier.agent],
    );
  });
}

/** Waits until a carriage judgement waits on the held actor row. */
export const judgementWaits = async (world: CarriedWorld, holder: HeldApp<void>): Promise<void> => {
  await waitersOf(world.w.fixture.db.admin, holder.pid);
};
