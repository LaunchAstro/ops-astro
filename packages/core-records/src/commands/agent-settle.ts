// SPDX-License-Identifier: AGPL-3.0-only
//
// How an agent call ends when it does not apply: the register row and the
// audit row for a refusal (`settle`), and the call's one audit row
// (`writeCallEvent`). The envelope (`agent-envelope.ts`) uses both. The replay
// (`agent-replay.ts`) writes every audit row through `writeCallEvent`, its
// `OPERATION_ID_REUSED` refusal included, and registers none, because the
// identity already holds its first request's row. So the agent path has one
// audit writer, not a second spelling of it (thermo recheck 9ddfa09, NA4).

import type { TenantQuery } from '../tenancy/database.ts';
import type { AgentSession } from '../identity/agent-login.ts';
import { writeAuditEvent, type AuditEvent } from './audit.ts';
import { asCallerVisible, type CommandRefusal } from './refusal.ts';
import { registerAttempt } from './register-store.ts';
import type { AgentRequest } from './agent-call.ts';

/** The register row and the audit row for a refusal, then the caller's version. */
export async function settle(
  tx: TenantQuery,
  session: AgentSession,
  request: AgentRequest,
  digest: string,
  refusal: CommandRefusal,
  withoutIdentity = false,
  attempted?: Readonly<Record<string, unknown>>,
): Promise<CommandRefusal> {
  const visible = asCallerVisible(refusal);
  if (!withoutIdentity) {
    await registerAttempt(tx, {
      operationId: request.operationId,
      command: request.command,
      actorId: session.actorId,
      digest,
      result: visible,
      recordId: null,
    });
  }
  await writeCallEvent(
    tx,
    session,
    request,
    digest,
    { outcome: 'refused', refusalCode: refusal.code, attempted: attempted ?? null },
    withoutIdentity,
  );
  return visible;
}

/**
 * This call's one audit row, every write of it on the agent path: the actor, the
 * command, the identity (none when the request carried no usable one) and the
 * digest, with what happened. An absent field is stored as null.
 */
export async function writeCallEvent(
  tx: TenantQuery,
  session: AgentSession,
  request: AgentRequest,
  digest: string,
  event: Pick<AuditEvent, 'outcome' | 'refusalCode' | 'subjectRecordId' | 'attempted'>,
  withoutIdentity = false,
): Promise<void> {
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.command,
    operationId: withoutIdentity ? null : request.operationId,
    payloadDigest: digest,
    ...event,
  });
}
