// SPDX-License-Identifier: AGPL-3.0-only
//
// The AI chat budget's hold (AW-04's planning cap; #1508's paid chat): the
// cap under its row lock, what is committed under it, the conversation's one
// envelope, and a reply's hold of its priced maximum as its own call row.
//
// Lock order: the cap (`for update`, the contract's first class), then AW-01's
// ceiling key and route key (`atCeiling`), as `core-runtime/src/locks.ts` says.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import { RATE_LIMITED, refused } from './broker-conversation.ts';
import { messageCall } from './broker-message-call.ts';
import { atCeiling, registerPromptCopy, type ReservedCall } from './broker-reserve.ts';
import { carriedIn, writeCarriers } from './broker-carriage.ts';
import type { BrokerRoute, Carrier, ModelCallResult } from './broker-types.ts';

/** The planning cap of a business nobody has moved it for: AUD 50, in minor units. */
export const PLANNING_CAP_DEFAULT = { limitMinor: 5_000, currency: 'AUD' } as const;

export interface Cap {
  readonly id: string;
  readonly limit_minor: string;
  readonly currency: string;
}

/** A call's committed amount: its actual once settled, its hold while held, else nothing. */
export const COMMITTED = `case when m.state = 'settled' then m.actual_minor
                        when m.state in ('reserved', 'dispatched', 'liability_unknown')
                          then m.reserved_minor
                        else 0 end`;

export async function planningCap(tx: TenantQuery, lock: boolean): Promise<Cap | undefined> {
  const [cap] = await tx.query<Cap>(
    `select id, limit_minor::text, currency from public.budget_caps
      where business_id = $1 and key = 'planning'${lock ? ' for update' : ''}`,
    [tx.businessId],
  );
  return cap;
}

/** The cap under its row lock, the default written as the business's row when there is none. */
export async function lockedOrDefault(tx: TenantQuery): Promise<Cap> {
  const cap = await planningCap(tx, true);
  if (cap !== undefined) return cap;
  await tx.query(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', $3, $4)
     on conflict (business_id, key) do nothing`,
    [tx.businessId, randomUUID(), PLANNING_CAP_DEFAULT.limitMinor, PLANNING_CAP_DEFAULT.currency],
  );
  const written = await planningCap(tx, true);
  if (written === undefined) throw new Error("the business's planning cap was not written");
  return written;
}

/** What is committed in business `$1` under the cap `capId` names, as one value. */
export const committedUnderSql = (capId: string): string =>
  `(select coalesce(sum(${COMMITTED}), 0) from public.model_calls m
      join public.planning_envelopes e
        on e.business_id = m.business_id and e.id = m.planning_envelope_id
     where m.business_id = $1 and e.cap_id = ${capId})::text`;

export async function committedUnder(tx: TenantQuery, capId: string): Promise<number> {
  const sql = `select ${committedUnderSql('$2')} as committed`;
  const [row] = await tx.query<{ committed: string }>(sql, [tx.businessId, capId]);
  return Number(row?.committed ?? 0);
}

/** The conversation's one envelope, opened on its first priced reply. */
export async function envelopeOf(
  tx: TenantQuery,
  capId: string,
  { conversation }: ConversationCallRequest,
): Promise<string> {
  await tx.query(
    `insert into public.planning_envelopes
       (business_id, id, cap_id, conversation_id, owner_person_id)
     values ($1, $2, $3, $4, $5)
     on conflict (business_id, conversation_id) do nothing`,
    [tx.businessId, randomUUID(), capId, conversation.id, conversation.ownerPersonId],
  );
  const [envelope] = await tx.query<{ id: string }>(
    `select id from public.planning_envelopes
      where business_id = $1 and conversation_id = $2 and owner_person_id = $3`,
    [tx.businessId, conversation.id, conversation.ownerPersonId],
  );
  if (envelope === undefined)
    throw new Error("the conversation's planning envelope is not its owner's");
  return envelope.id;
}

export type Held = { readonly ok: true; readonly reserved: ReservedCall } | ModelCallResult;

/**
 * Under the cap's lock: the message's call first (a twin is told where its
 * answer is, never that the model is busy), then the ceiling, room
 * for the priced maximum, the envelope and the held, sent row naming its
 * message, with its carriers row on a carried deployment, whose agent must
 * still be a member. A twin that inserted after the lookup wins the unique
 * index, and this holds nothing.
 */
export async function holdPriced(
  tx: TenantQuery,
  request: ConversationCallRequest,
  operation: ModelOperation,
  route: BrokerRoute,
  sent: { readonly account: string | null; readonly carrier?: Carrier | undefined },
  callId: string = randomUUID(),
): Promise<Held> {
  const { account, carrier } = sent;
  const cap = await lockedOrDefault(tx);
  const earlier = await messageCall(tx, request.messageId);
  if (earlier !== undefined) return earlier;
  if (await atCeiling(tx, operation, route)) {
    return (await messageCall(tx, request.messageId)) ?? RATE_LIMITED;
  }
  const committed = await committedUnder(tx, cap.id);
  const limitMinor = Number(cap.limit_minor);
  if (committed + operation.maximumMinor > limitMinor) {
    const leftMinor = Math.max(0, limitMinor - committed);
    return { ok: false, code: 'BUDGET_UNAVAILABLE', callId: null, leftMinor };
  }
  if (carrier !== undefined && !(await carriedIn(tx, request.conversation.id, carrier))) {
    return refused('CARRIAGE_UNAVAILABLE');
  }
  const envelopeId = await envelopeOf(tx, cap.id, request);
  const held = { callId, envelopeId, operation, route, account };
  if (!(await insertHeld(tx, request, held))) {
    return (await messageCall(tx, request.messageId)) ?? refused('STILL_ANSWERING');
  }
  await registerPromptCopy(tx, callId);
  if (carrier !== undefined) await writeCarriers(tx, callId, carrier);
  return {
    ok: true,
    reserved: { callId, operation, route, reservedMinor: operation.maximumMinor },
  };
}

/** The held, sent row naming its message; false when the message's call is already there. */
async function insertHeld(
  tx: TenantQuery,
  request: ConversationCallRequest,
  held: {
    readonly callId: string;
    readonly envelopeId: string;
    readonly operation: ModelOperation;
    readonly route: BrokerRoute;
    readonly account: string | null;
  },
): Promise<boolean> {
  const { callId, envelopeId, operation, route, account } = held;
  const inserted = await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, conversation_message_id, planning_envelope_id,
        operation_key, state, reserved_minor, route_key, route_reach, credential_kind, provider,
        credential_ref, account, started_at)
     values ($1, $2, $3, $4, $5, $6, 'dispatched', $7, $8, $9, $10, $11, $12, $13,
             clock_timestamp())
     on conflict (business_id, conversation_message_id) where conversation_message_id is not null
     do nothing
     returning id`,
    [
      tx.businessId,
      callId,
      request.conversation.id,
      request.messageId ?? null,
      envelopeId,
      operation.key,
      operation.maximumMinor,
      route.key,
      route.reach,
      route.credentialKind,
      route.provider,
      route.credentialRef,
      account,
    ],
  );
  return inserted.length > 0;
}
