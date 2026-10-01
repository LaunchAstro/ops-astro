// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent entry's work and its applied answer (agent-envelope.ts): the
// savepoint a handler runs in, and the register row and audit event an applied
// call leaves, with the delegation credential kept out of the register.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { registerAttempt, type CommandHandle } from './register-store.ts';
import { isRefused, type Applied, type HandlerOutcome } from './outcome.ts';
import { writeAuditEvent } from './audit.ts';
import type { AgentCall } from './agent-call.ts';
import type { IdentifiedRequest } from './requests.ts';

/** The handler's work in a savepoint of its own. */
export async function inSavepoint(
  tx: TenantQuery,
  work: () => Promise<HandlerOutcome>,
): Promise<HandlerOutcome> {
  await tx.query('savepoint agent_work');
  const outcome = await work();
  // A refusal rolls back whatever reached the database on the way to it, for
  // the same reason and by the same mechanism as the person envelope's.
  await tx.query(
    // A refusal rolls back, except the one that kept something on purpose:
    // `Refused.retains` is set by a handler that wrote a row the contract
    // retains alongside the refusal, and rolling back would discard it.
    isRefused(outcome) && outcome.retains !== true
      ? 'rollback to savepoint agent_work'
      : 'release savepoint agent_work',
  );
  return outcome;
}

/** An applied call: its register row and its audit event, in the call's transaction. */
export async function recordApplied(
  tx: TenantQuery,
  session: AgentCall['session'],
  request: IdentifiedRequest,
  digest: string,
  outcome: Applied,
): Promise<CommandHandle> {
  const handle: CommandHandle = {
    command: request.command,
    recordId: outcome.recordId,
    revision: outcome.revision,
    detail: outcome.detail,
  };
  await registerAttempt(tx, {
    operationId: request.operationId,
    command: request.command,
    actorId: session.actorId,
    digest,
    result: storable(handle),
    recordId: outcome.recordId,
  });
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.command,
    operationId: request.operationId,
    payloadDigest: digest,
    outcome: 'applied',
    subjectRecordId: outcome.recordId,
  });
  return handle;
}

/**
 * The handle as the register keeps it: without the delegation credential.
 *
 * The credential is "stored by hash" (TRANSACTION-CONTRACT) and
 * `delegations.credential_hash` is that store. A register row holding it in
 * the clear would be a second, readable copy, and a replay would hand it to
 * whoever repeated the operation id. So the row keeps every handle and a null
 * credential; `replayPickup` derives the credential again rather than reading
 * it from anywhere.
 */
function storable(handle: CommandHandle): CommandHandle {
  if (!('credential' in handle.detail)) return handle;
  return { ...handle, detail: { ...handle.detail, credential: null } };
}
