// SPDX-License-Identifier: AGPL-3.0-only
//
// The one thing an agent handback refused on authority keeps: its report, for
// a delegation that has ended or narrowed. `AGENT_OPERATIONS` names it as the
// handback row's `onRefused`.

import type { TenantQuery } from '../tenancy/database.ts';
import type { AgentSession } from '../identity/agent-login.ts';
import {
  resolveHistoricalDelegation,
  resolveNarrowedDelegation,
} from '../authority/delegations.ts';
import { retainHistoricalReport } from '../../../core-runtime/src/handback.ts';
import type { CommandRefusal } from './refusal.ts';
import type { CommandDeclaration } from './surface.ts';
import type { AgentCall, HandbackOperands } from './agent-call.ts';
import { isUuid } from '../tenancy/ids.ts';
import { taskOfLease } from './prepare.ts';

/**
 * T4's evidence-only intake for an agent whose delegation has ended.
 *
 * Supersession, cancellation, settlement and plain expiry leave the original
 * agent's credential answering `DELEGATION_NOT_LIVE`; a delegation revoked for
 * authority loss answers `DELEGATION_NARROWED` (R-B). Either way the new
 * handback is refused before any lease is read, and the refusal stands: its
 * code, its status and R-B's recorded cause are unchanged. T4 line 76 names
 * "a revoked/narrowed agent" among the holders whose report is kept
 * (ROOT-NARROWED-REPORT-RULING), so both codes reach here.
 *
 * A narrowed delegation need not have been revoked. When the person's write
 * grant reaches its own expiry the delegation stays live, the authority check
 * answers `DELEGATION_NARROWED`, and no durable cause is ever written
 * (REVIEW-AGENT-BOUNDARY 62307d5 N1, ROOT-GRANT-EXPIRY-INTAKE-RULING). That
 * case is resolved again here, not inferred from the code: the credential must
 * still resolve live for this business and this agent, and the check on the
 * presented lease's own task must refuse it as narrowed (`narrowedOnLease`).
 *
 * What this adds is the report: when the credential names a delegation of
 * this business and this authenticated agent that is not live, or no longer
 * covered, for the reason the refusal gave, and the presented lease and fence
 * are that delegation's exactly, the report is kept as one unaccepted
 * `handback_reports` row naming the refusal (`retainHistoricalReport`).
 * Nothing is read back to the caller and nothing else is written: no
 * settlement, successor, lease, delegation or money.
 *
 * The code alone authorises nothing. Every other refusal, and any binding that
 * does not hold, retains nothing. A replay never reaches here: a refused
 * handback's replay is answered from its register row (`answerReplay`,
 * `agent-replay.ts`), and only a new operation id is a new late report.
 */
export async function retainLateHandback(
  tx: TenantQuery,
  { session, credential, request, declaration }: AgentCall,
  operands: HandbackOperands,
  refusal: CommandRefusal,
): Promise<void> {
  if (refusal.code !== 'DELEGATION_NOT_LIVE' && refusal.code !== 'DELEGATION_NARROWED') return;
  if (credential === undefined || credential === '') return;
  const leaseId = request['leaseId'];
  if (!isUuid(leaseId)) return;
  const historical =
    (await resolveHistoricalDelegation(tx, session.actorId, credential, refusal.code)) ??
    (refusal.code === 'DELEGATION_NARROWED'
      ? await narrowedOnLease(tx, session, credential, leaseId, declaration)
      : undefined);
  if (historical === undefined) return;
  await retainHistoricalReport(tx, {
    leaseId,
    delegationId: historical.id,
    holderActorId: session.actorId,
    // As `handbackOperands` read them: a fence that is not a number or an
    // outcome that is not a string was refused there and never reaches here.
    // An absent report is an empty one, as the person handler reads it.
    fence: operands.fence,
    outcome: operands.outcome,
    report: operands.report ?? {},
    refusalCode: refusal.code,
  });
}

/**
 * The live delegation this credential names, when the handback's own task is
 * within its purpose and its person no longer holds the write that covers it.
 *
 * The task is the presented lease's, read as `subjectTaskId` reads it but with
 * no fallback: a lease that is not this business's names no task, and nothing
 * is kept for it. Whether the lease is also this delegation's, this agent's
 * and this fence's is `retainHistoricalReport`'s exact binding, after this.
 */
async function narrowedOnLease(
  tx: TenantQuery,
  session: AgentSession,
  credential: string,
  leaseId: string,
  declaration: CommandDeclaration,
): Promise<{ readonly id: string } | undefined> {
  const taskId = await taskOfLease(tx, leaseId);
  if (taskId === undefined) return undefined;
  return await resolveNarrowedDelegation(tx, session.actorId, credential, {
    collection: declaration.collection,
    action: declaration.action,
    scope: { kind: 'record', id: taskId },
  });
}
