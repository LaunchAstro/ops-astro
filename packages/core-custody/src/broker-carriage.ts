// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation call carried to the model agent on the owner's machine
// (#1531, live chat route B), as the broker records it: the agent must be an
// open member of the conversation (a task's call, #1703: an active agent of the
// business), the call is written with its carriers row,
// and the lost-call sweep ends a carried call by what that row proves.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Carrier } from './broker-types.ts';

/**
 * The carrier's agent is an open member of the conversation, held for share
 * until the call is written. The conversation's row is taken first, as a
 * model pick and a purge take it before the membership, so neither waits on
 * the other in a cycle.
 */
export async function carriedIn(
  tx: TenantQuery,
  conversationId: string,
  carrier: Carrier,
): Promise<boolean> {
  await tx.query(
    `select 1 from public.conversations where business_id = $1 and id = $2 for key share`,
    [tx.businessId, conversationId],
  );
  const member = await tx.query(
    `select 1 from public.conversation_agent_members
      where business_id = $1 and conversation_id = $2 and agent_actor_id = $3 and left_at is null
      for share`,
    [tx.businessId, conversationId, carrier.agent],
  );
  return member.length > 0;
}

/** The carrier's agent is an active agent of this business, held for share until the call is written. */
export async function carriesHere(tx: TenantQuery, carrier: Carrier): Promise<boolean> {
  const agent = await tx.query(
    `select 1 from public.actors
      where business_id = $1 and id = $2 and kind = 'agent' and active for share`,
    [tx.businessId, carrier.agent],
  );
  return agent.length > 0;
}

/** The carriers row, written with its call: ids only, every time still unset. */
export async function writeCarriers(
  tx: TenantQuery,
  callId: string,
  carrier: Carrier,
): Promise<void> {
  await tx.query(
    `insert into public.model_call_carriers (business_id, call_id, agent_actor_id)
     values ($1, $2, $3)`,
    [tx.businessId, callId, carrier.agent],
  );
}

/**
 * A carried call (#1531), by what its carriers row proves. Once offered, its
 * request goes only after `request_at` commits, so one still null sent nothing:
 * released 60 s after its start. One that may have gone is held once
 * `answer_by` plus 60 s has passed, after any settlement could still take it.
 * The rows are locked first, skipping a call the send or the settlement holds,
 * and the carriers row with it, so a `request_at` committed since this
 * statement's snapshot is read again before anything is released.
 */
export async function sweepCarried(
  tx: TenantQuery,
): Promise<{ readonly held: number; readonly released: number }> {
  const lost = await tx.query<{ readonly id: string; readonly sent: boolean }>(
    `select c.id, k.request_at is not null as sent
       from public.model_calls c
       join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      where c.business_id = $1 and c.state = 'dispatched'
        and ((k.offered_at is not null and k.request_at is null
              and c.started_at <= clock_timestamp() - interval '60 seconds')
             or k.answer_by <= clock_timestamp() - interval '60 seconds')
      for update of c, k skip locked`,
    [tx.businessId],
  );
  const ids = (sent: boolean) => lost.filter((call) => call.sent === sent).map((call) => call.id);
  const released = await tx.query(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp(), drop_state = null
      where business_id = $1 and id = any($2::uuid[]) and state = 'dispatched'
      returning id`,
    [tx.businessId, ids(false)],
  );
  const held = await tx.query(
    `update public.model_calls
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer',
            unknown_since = clock_timestamp()
      where business_id = $1 and id = any($2::uuid[]) and state = 'dispatched'
      returning id`,
    [tx.businessId, ids(true)],
  );
  return { held: held.length, released: released.length };
}
