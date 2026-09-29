// SPDX-License-Identifier: AGPL-3.0-only
//
// `model.call`, the agent's priced model call (AW-01), through the credential
// broker only.
//
// The call spans a network send, so it cannot be one transaction. It runs as
// the agent entry's own transaction, then the send:
//
// 1. The agent entry, unchanged (`executeAgentOperation`): the agent login,
//    the register lookup and replay, the operands, the delegation on the
//    lease's task, and the body against its surface row. Its serve is the
//    broker's reserve in the same transaction, so the hold, the prompt copy's
//    registration, the register row and the audit event commit as one. A
//    repeat of the operation id replays that row, and two at once cannot
//    both hold: the second loses the register's identity key and replays.
// 2. After commit, the broker starts, sends through custody and settles, each
//    in its own transaction, re-reading the lease, the delegation and the
//    reservation under their locks (`sendReservedCall`).
//
// The caller is the lease holder the envelope resolved, never the body, and
// the call is unattended: an agent is no person's own session. The model's
// words are handed back once, on the call that made them, and are never
// stored; a replay reports the call as the ledger has it now.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import { isUuid } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import {
  reserveModelCall,
  sendReservedCall,
  type AuditNote,
  type Broker,
  type ModelCaller,
  type ModelCallRequest,
  type ModelCallResult,
  type Reservation,
  type ReservedCall,
} from '../../../core-custody/src/index.ts';
import type { AgentRequest } from './agent-call.ts';
import { executeAgentOperation } from './agent-envelope.ts';
import { modelCallRow } from './agent-operations.ts';
import { writeAuditEvent } from './audit.ts';
import { refused, refusedRetaining, type Refused } from './outcome.ts';
import { isCommandRefusal, refuseCommand } from './refusal.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';

/** The broker as a deployment configures it. The audit is this layer's, per caller. */
export type ModelBroker = Omit<Broker, 'audit'>;

/** The agent prefix's executor for `model.call`, the composition root's to build. */
export type ModelCallExecutor = (
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  credential: string | undefined,
  request: AgentRequest,
) => Promise<CommandResult>;

/** What the reserving transaction held, for the send after it commits. */
interface Held {
  readonly caller: ModelCaller;
  readonly request: ModelCallRequest;
  readonly reserved: ReservedCall;
  readonly broker: Broker;
}

export function modelCallExecutor(broker: ModelBroker): ModelCallExecutor {
  return async (database, businessId, presented, credential, request) => {
    let held: Held | undefined;
    const row = modelCallRow(async (tx, call, operands, delegation) => {
      const caller: ModelCaller = {
        actorId: call.session.actorId,
        delegationId: delegation.id,
        attendedByPersonId: null,
      };
      const audited: Broker = { ...broker, audit: auditAs(call.session.actorId) };
      const stepId = await stepOfLease(tx, operands.leaseId);
      const modelRequest: ModelCallRequest = { ...operands, stepId };
      const reservation = await reserveModelCall(tx, caller, modelRequest, audited);
      if (!reservation.ok) return refusalOf(reservation);
      held = { caller, request: modelRequest, reserved: reservation.reserved, broker: audited };
      return {
        recordId: null,
        revision: null,
        detail: { callId: reservation.reserved.callId, state: 'reserved' },
      };
    });
    const admitted = await executeAgentOperation(
      database,
      businessId,
      presented,
      credential,
      request,
      row,
    );
    if (isCommandRefusal(admitted)) return admitted;
    const callId = String(admitted.detail['callId']);
    // Held by this request and committed: the answer's call is the one it
    // held. Anything else is a replay, including a first attempt that lost
    // the identity key and was retried into one.
    if (held === undefined || held.reserved.callId !== callId) {
      return await answerFrom(database, businessId, admitted, callId);
    }
    const sent = await sendReservedCall(
      database,
      businessId,
      held.caller,
      held.request,
      held.reserved,
      held.broker,
    );
    return await answerFrom(database, businessId, admitted, callId, sent);
  };
}

/**
 * The run's step this call bills: the one the lease's attempt was reserved
 * for, so the caller never names it. A lease that is not a lease here, or
 * not bound to exactly one attempt, names none, and the broker refuses the
 * made-up step as it refuses a made-up lease (`LEASE_NOT_OWNED`).
 */
async function stepOfLease(tx: TenantQuery, leaseId: string): Promise<string> {
  if (!isUuid(leaseId)) return '';
  const steps = await tx.query<{ step_id: string }>(
    `select step_id from public.attempts where business_id = $1 and lease_id = $2 limit 2`,
    [tx.businessId, leaseId],
  );
  return steps.length === 1 ? String(steps[0]?.step_id) : '';
}

/** The broker's events, as the caller's, in the broker's transaction. */
function auditAs(actorId: string): Broker['audit'] {
  return async (tx: TenantQuery, note: AuditNote): Promise<void> => {
    await writeAuditEvent(tx, {
      actorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: payloadDigest(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  };
}

const FIXES: Readonly<Record<string, readonly string[]>> = {
  RATE_LIMITED: ['Wait, then send the call again with a new operation id.'],
  BUDGET_UNAVAILABLE: ["The run's reservation has no room for this call's priced maximum."],
  OPERATION_NOT_CATALOGUED: ['Name an operation the broker has registered.'],
  EFFECT_NOT_RECONCILABLE: [
    'An operation with no proof that nothing happened is never dispatched.',
  ],
};

/** A reserve refusal in the register's words. One that recorded its step keeps it. */
function refusalOf(reservation: Extract<Reservation, { ok: false }>): Refused {
  const words = reservation.words === undefined ? [] : [reservation.words];
  const wait =
    reservation.retryAfterSeconds === undefined
      ? []
      : [`Wait ${String(reservation.retryAfterSeconds)} seconds.`];
  const refusal = refuseCommand(
    reservation.code,
    ['model.call'],
    [...words, ...wait, ...(FIXES[reservation.code] ?? [])],
  );
  return reservation.callId === null ? refused(refusal) : refusedRetaining(refusal);
}

interface LedgerRow {
  readonly state: string;
  readonly reserved_minor: string;
  readonly actual_minor: string | null;
  readonly observed_minor: string | null;
  readonly drop_state: string | null;
}

const minor = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The call as its ledger row has it now, with the model's words only when this request made them. */
async function answerFrom(
  database: Database,
  businessId: BusinessId,
  admitted: CommandHandle,
  callId: string,
  sent?: ModelCallResult,
): Promise<CommandHandle> {
  const [call] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<LedgerRow>(
        `select state, reserved_minor::text as reserved_minor, actual_minor::text as actual_minor,
                observed_minor::text as observed_minor, drop_state
           from public.model_calls where business_id = $1 and id = $2`,
        [tx.businessId, callId],
      ),
  );
  const words = sent === undefined ? {} : sent.ok ? { text: sent.text } : { outcome: sent.code };
  return {
    ...admitted,
    detail: {
      callId,
      state: call?.state ?? null,
      reservedMinor: minor(call?.reserved_minor),
      actualMinor: minor(call?.actual_minor),
      observedMinor: minor(call?.observed_minor),
      drop: call?.drop_state ?? null,
      ...words,
    },
  };
}
