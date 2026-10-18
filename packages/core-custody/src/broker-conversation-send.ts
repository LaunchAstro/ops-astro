// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation seam's send and settlement (`broker-conversation.ts`):
// through custody, a carried call with its handoff, then the answer settled
// at nothing or held, never above nothing. Only a call still dispatched
// settles, and a carried one only through its custody's fence; a settled
// message's answer is copied until its reply is kept (#1563). Split from
// that file for its line cap.

import type { BusinessId, Database, TransactionQuery } from '../../core-records/src/index.ts';
import { WORKER_LOST } from './broker-fault.ts';
import { copyAnswer } from './broker-message-call.ts';
import type { ReservedCall } from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced, type Settlement } from './broker-settle.ts';
import type { Broker, ModelCallResult, ResolvedField } from './broker-types.ts';
import type { Handoff } from './carriage.ts';

/** Through custody, then the answer settles at nothing or is held (never settled above nothing). */
export async function sendAndSettle(
  database: Database,
  businessId: BusinessId,
  called: ReservedCall,
  fields: readonly ResolvedField[],
  broker: Broker,
  asked: {
    readonly model?: string;
    readonly onPiece?: (text: string) => void;
    readonly carry?: (callId: string) => Handoff;
    readonly streamed: boolean;
  },
): Promise<ModelCallResult> {
  const { callId, operation, route } = called;
  const { model, onPiece, streamed, carry } = asked;
  // A carried call's pieces come as display text already, filtered on the owner's machine.
  const handoff = carry?.(callId);
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${operation.provider}`);
  const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  // AW-10: the call names itself to the provider, so a lookup can ask about it.
  const built = adapter.build(values, callId, model, streamed);
  const reader = onPiece === undefined || !streamed ? undefined : operation.pieces?.();
  const outcome = await broker.custody.dispatch(
    route.credentialRef,
    {
      destination: operation.destination,
      path: built.path,
      method: built.method,
      body: built.body,
      timeoutMs: operation.timeoutMs,
      maxResponseBytes: operation.maxResponseBytes,
    },
    handoff !== undefined || reader === undefined || onPiece === undefined
      ? onPiece
      : (chunk) => {
          for (const text of reader.push(chunk)) onPiece(text);
        },
    undefined,
    handoff,
  );
  const settlement = settlementOf(outcome, operation, adapter, streamed);
  return await database.withBusiness(
    businessId,
    async (tx) => await settledFor(tx, called, settlement, broker),
  );
}

/**
 * Custody's outcome for the person waiting on it: held, released, or settled
 * at nothing. Only a call still open settles: one the sweep held, or anything
 * else moved, is no success and keeps no answer.
 */
async function settledFor(
  tx: TransactionQuery,
  called: ReservedCall,
  settlement: Settlement,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId } = called;
  if (settlement.kind === 'unknown') return await hold(tx, called, null, settlement, broker);
  if (settlement.kind === 'nothing') return await release(tx, called, settlement.reason, broker);
  if (settlement.costMinor !== 0) {
    const observed = Number.isSafeInteger(settlement.costMinor) ? settlement.costMinor : null;
    return await hold(tx, called, observed, null, broker);
  }
  const [call] = await tx.query<{ readonly state: string }>(
    'select state from public.model_calls where business_id = $1 and id = $2 for update',
    [tx.businessId, callId],
  );
  // A carried call settles only through its fence: the runner sent to, before its `answer_by`.
  const fenced = broker.custody.fenceIn === undefined || (await broker.custody.fenceIn(tx, callId));
  if (call?.state === 'dispatched' && !fenced) {
    await hold(tx, called, null, { kind: 'unknown', ...WORKER_LOST }, broker);
  }
  if (
    call?.state !== 'dispatched' ||
    !fenced ||
    !(await settlePriced(tx, called, settlement, broker))
  ) {
    return { ok: false, code: 'DECISION_STALE', callId };
  }
  const { text } = settlement.answer;
  // Copied as it settles, so a reply keep that fails after this commits can be made good once.
  await copyAnswer(tx, callId, text);
  return { ok: true, callId, text, reservedMinor: 0, actualMinor: 0, releasedMinor: 0 };
}
