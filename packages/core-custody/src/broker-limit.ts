// SPDX-License-Identifier: AGPL-3.0-only
//
// A run attempt's call limit and each hold's place (#1623 R3, design R4). The
// reserve counts the attempt's calls under the run lock it holds, so two holds
// never take one place, and a turn must name that place as its ordinal. Each
// hold records its place and the attempt's limit, the one its first hold
// recorded. The reserve refuses a hold at the limit, a backstop; the writer is
// the settlement of the limit-th call, which ends the attempt `call_limit`
// whatever its answer.

import type { FieldSource, ModelAnswer } from '../../core-connectors/src/index.ts';
import { AGENT_MODEL_CALL_LIMIT } from '../../core-wire/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { stopAtSettlement } from './broker-stop.ts';
import { answerDigest } from './broker-turn.ts';
import type { ModelCallResult } from './broker-types.ts';

/** The next hold's place among the attempt's calls, from 0, and the attempt's limit. */
export interface Place {
  readonly ordinal: number;
  readonly limit: number;
}

/** Under the run lock: the next place on a run attempt's lease, or none for other work. */
export async function placeOf(
  tx: TenantQuery,
  leaseId: string,
  configured: number = AGENT_MODEL_CALL_LIMIT,
): Promise<Place | undefined> {
  const [row] = await tx.query<{ attempt: boolean; made: string; recorded: number | null }>(
    `select exists (select 1 from public.attempts a
                     where a.business_id = $1 and a.lease_id = $2) as attempt,
            (select count(*) from public.model_calls c
              where c.business_id = $1 and c.lease_id = $2)::text as made,
            (select f.call_limit from public.model_calls f
              where f.business_id = $1 and f.lease_id = $2 and f.call_ordinal is not null
              order by f.call_ordinal limit 1) as recorded`,
    [tx.businessId, leaseId],
  );
  if (row?.attempt !== true) return undefined;
  return { ordinal: Number(row.made), limit: row.recorded ?? configured };
}

/** Whether the call took its attempt's last place, or one past it. */
async function reachesLimit(tx: TenantQuery, callId: string): Promise<boolean> {
  const [call] = await tx.query<{ reaches: boolean | null }>(
    `select call_ordinal + 1 >= call_limit as reaches from public.model_calls
      where business_id = $1 and id = $2`,
    [tx.businessId, callId],
  );
  return call?.reaches === true;
}

/**
 * A priced answer on work that stands, handed back once (#1623 R3). A turn's
 * answer keeps its digest, never its words, and the class of the turn that
 * made it. The settlement of the attempt's limit-th call is the call limit's
 * writer, whatever its answer, one too deep to digest included: the answer still comes back,
 * marked terminal.
 */
export async function settledAnswer(
  tx: TenantQuery,
  leaseId: string,
  reserved: { readonly callId: string; readonly reservedMinor: number },
  settlement: { readonly costMinor: number; readonly answer: ModelAnswer },
  turn: FieldSource | undefined,
): Promise<ModelCallResult> {
  const { callId, reservedMinor } = reserved;
  const { costMinor } = settlement;
  const { text, toolCalls } = settlement.answer;
  const digest = turn === undefined ? undefined : answerDigest(text, toolCalls ?? []);
  if (turn !== undefined && digest !== undefined) {
    await tx.query(
      `update public.model_calls set answer_digest = $3, answer_source = $4
        where business_id = $1 and id = $2 and state = 'settled'`,
      [tx.businessId, callId, digest, turn],
    );
  }
  const result = {
    ok: true as const,
    callId,
    text,
    ...(toolCalls === undefined ? {} : { toolCalls }),
    reservedMinor,
    actualMinor: costMinor,
    releasedMinor: reservedMinor - costMinor,
  };
  if (await reachesLimit(tx, callId)) {
    return await stopAtSettlement(tx, leaseId, 'stands', 'CALL_LIMIT_REACHED', {
      ...result,
      terminal: 'call_limit',
    });
  }
  // A turn's answer too deep to digest can never be bound by a later turn: the call stays
  // settled priced and, short of the limit, the attempt ends with the turn's refusal (S1900-6).
  if (turn !== undefined && digest === undefined) {
    const refused = { ok: false as const, code: 'TURN_MALFORMED' as const, callId };
    return await stopAtSettlement(tx, leaseId, 'stands', 'TURN_MALFORMED', refused);
  }
  return result;
}
