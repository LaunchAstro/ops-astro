// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals by person (C52-A; CS-6.10). The envelope has already
// checked `automation:manage` business-wide and refused every agent. What is
// left is the value, then the identifiers, where another business's row
// answers exactly as a fabricated one does (row security hides it).
//
// An adoption pins an exact released version and is that pin's standing
// approval. A rollback adopts again the highest-numbered version below the
// pin that this activation adopted before under an approval nobody revoked;
// the newer version and every earlier adoption stay in history. Revoking an
// approval is its own act and leaves the pin; turning an automation off ends
// its approval with it. Each change is compared with the revision the caller
// read, first here and again under the activation's lock (`approvals.ts`), so
// a claim, a dispatch and these changes take turns. Before any automation row,
// each holds the caller's automation grants for share and asks the key again
// (`automation-authority.ts`), so a revocation of the grant that admitted it
// either refuses it or waits for it; then it locks the activation and asks
// once more at the clock after that wait, so a grant that ran out meanwhile
// refuses it too. A rollback picks its target under that lock, after any
// revocation that held it has committed. Once its rows are written, each
// takes the audit chain's lock, its last wait, and asks a last time at that
// clock, its session included (`standsAtCommit`). Only an automation that is
// on is approved.
//
// A repeat is refused, not answered as done: revoking a revoked approval and
// turning off an automation that is off are each TRANSITION_NOT_PERMITTED.
// The same attempt sent again (its `operationId`) is the envelope's replay.

import {
  adoptVersion,
  advisoryLock,
  approvalActivation,
  isUuid,
  lockActivation,
  readActivation,
  readVersion,
  revokeApproval,
  rollbackTarget,
  sessionEndedSince,
  turnOffActivation,
  type ActivationRow,
  type AdoptionAct,
  type DefinitionVersionRow,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  ActivationAdoptRequest,
  ActivationRollBackRequest,
  ActivationTurnOffRequest,
  ApprovalRevokeRequest,
} from './automation-requests.ts';
import { askAutomationAuthority, holdAutomationAuthority } from './automation-authority.ts';
import { invalid, isRevision, notPermitted, staleAt } from './automations.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const unknownActivation = (): HandlerOutcome => refused(refuseNotFound(['activationId']));

const SIGNED_OUT = 'sign in again: this session was signed out';
const SIGNED_OUT_KEPT =
  'The session that sent this change was signed out before it applied; nothing changed.';

/** The activation at the revision the caller read, or the refusal to answer. */
async function activationAt(
  tx: TenantQuery,
  activationId: string,
  expectedRevision: number,
): Promise<ActivationRow | HandlerOutcome> {
  if (!isUuid(activationId)) return unknownActivation();
  const current = await readActivation(tx, activationId);
  if (current === null) return unknownActivation();
  return current.revision === expectedRevision ? current : staleAt(current.revision);
}

const isOutcome = (value: ActivationRow | HandlerOutcome): value is HandlerOutcome =>
  !('definitionId' in value);

/**
 * The activation locked, then the declaration's key asked again at the clock
 * after that wait, the caller's grants still held (so none was revoked
 * meanwhile): a grant that ran out while this waited on the activation
 * refuses the change. Nothing when it still holds, or the refusal.
 */
async function lockedAuthority(
  tx: TenantQuery,
  context: CommandContext,
  activationId: string,
): Promise<HandlerOutcome | null> {
  await lockActivation(tx, activationId);
  return await holdAutomationAuthority(tx, context);
}

/**
 * The last authority read, once the change's rows are written: after the
 * audit chain's lock, its last wait (as `tasks-agent.ts` takes it; the key is
 * the chain trigger's, `business_id::text`, lower case). The key is asked at
 * that clock, the grants still held, and the session that sent the change must
 * not have ended meanwhile: a sign-out here writes its own audit event, so it
 * either committed before this lock and refuses the change, or waits for it;
 * one through another business takes the session's ending keys, which the
 * read below holds shared until commit, so it either committed before that
 * read or waits for the change (`sessionEndedHeld`). So does a password
 * reset's window, which takes the login's subject key as it opens.
 * A refusal rolls the change's rows back with the handler's savepoint. The
 * register keeps it as a scope refusal: the same attempt sent again from a
 * later sign-in is not told that its own session ended.
 */
async function standsAtCommit(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome | null> {
  await advisoryLock(tx, tx.businessId.toLowerCase());
  if (await sessionEndedSince(tx, context.session)) {
    return {
      refusal: refuseCommand('AUTH_SESSION_EXPIRED', [], [SIGNED_OUT]),
      kept: refuseCommand('SCOPE_NOT_GRANTED', [], [SIGNED_OUT_KEPT]),
    };
  }
  return await askAutomationAuthority(tx, context);
}

/** The caller's grants held before any automation row, then `lockedAuthority`. */
async function authorityOver(
  tx: TenantQuery,
  context: CommandContext,
  activationId: string,
): Promise<HandlerOutcome | null> {
  return (
    (await holdAutomationAuthority(tx, context)) ??
    (await lockedAuthority(tx, context, activationId))
  );
}

async function adopt(
  tx: TenantQuery,
  context: CommandContext,
  current: ActivationRow,
  to: { readonly version: DefinitionVersionRow; readonly act: AdoptionAct },
): Promise<HandlerOutcome> {
  if (!current.enabled) {
    return notPermitted('enabled=false', 'Switch the automation on before approving a version.');
  }
  if (to.version.definitionId !== current.definitionId) {
    return notPermitted('versionId', 'Adopt a version of the activation’s own definition.');
  }
  if (!to.version.modes.includes(current.mode)) {
    return notPermitted(`mode=${current.mode}`, 'Adopt a version that permits this mode.');
  }
  const result = await adoptVersion(tx, {
    activationId: current.id,
    versionId: to.version.id,
    expectedRevision: current.revision,
    act: to.act,
    actorId: context.session.actorId,
  });
  if (result.kind === 'unknown') return unknownActivation();
  if (result.kind === 'stale') return staleAt(result.revision);
  const atCommit = await standsAtCommit(tx, context);
  if (atCommit !== null) return atCommit;
  const { activation, approval } = result;
  return applied(activation.id, activation.revision, {
    activationId: activation.id,
    versionId: activation.versionId,
    approvalId: approval.id,
    act: approval.act,
  });
}

export async function adoptActivationVersion(
  tx: TenantQuery,
  context: CommandContext,
  request: ActivationAdoptRequest,
): Promise<HandlerOutcome> {
  if (!isRevision(request.expectedRevision)) return invalid('expectedRevision');
  if (!isUuid(request.activationId)) return unknownActivation();
  const lost = await authorityOver(tx, context, request.activationId);
  if (lost !== null) return lost;
  const current = await activationAt(tx, request.activationId, request.expectedRevision);
  if (isOutcome(current)) return current;
  const version = isUuid(request.versionId) ? await readVersion(tx, request.versionId) : null;
  if (version === null) return refused(refuseNotFound(['versionId']));
  return await adopt(tx, context, current, { version, act: 'adopted' });
}

export async function rollBackActivation(
  tx: TenantQuery,
  context: CommandContext,
  request: ActivationRollBackRequest,
): Promise<HandlerOutcome> {
  if (!isRevision(request.expectedRevision)) return invalid('expectedRevision');
  if (!isUuid(request.activationId)) return unknownActivation();
  const lost = await authorityOver(tx, context, request.activationId);
  if (lost !== null) return lost;
  const current = await activationAt(tx, request.activationId, request.expectedRevision);
  if (isOutcome(current)) return current;
  const version = await rollbackTarget(tx, current.id);
  if (version === null) {
    return notPermitted(
      'versionId',
      'No earlier version of this automation was adopted and left unrevoked; there is none to roll back to.',
    );
  }
  return await adopt(tx, context, current, { version, act: 'rolled_back' });
}

export async function turnOffActivationAsPerson(
  tx: TenantQuery,
  context: CommandContext,
  request: ActivationTurnOffRequest,
): Promise<HandlerOutcome> {
  if (!isRevision(request.expectedRevision)) return invalid('expectedRevision');
  if (!isUuid(request.activationId)) return unknownActivation();
  const lost = await authorityOver(tx, context, request.activationId);
  if (lost !== null) return lost;
  const result = await turnOffActivation(tx, {
    activationId: request.activationId,
    expectedRevision: request.expectedRevision,
    actorId: context.session.actorId,
  });
  if (result.kind === 'unknown') return unknownActivation();
  if (result.kind === 'stale') return staleAt(result.revision);
  if (result.kind === 'already_off') {
    return notPermitted('enabled=false', 'The automation is already off.');
  }
  const atCommit = await standsAtCommit(tx, context);
  if (atCommit !== null) return atCommit;
  const { activation } = result;
  return applied(activation.id, activation.revision, {
    activationId: activation.id,
    enabled: activation.enabled,
  });
}

export async function revokeStandingApproval(
  tx: TenantQuery,
  context: CommandContext,
  request: ApprovalRevokeRequest,
): Promise<HandlerOutcome> {
  if (!isUuid(request.approvalId)) return refused(refuseNotFound(['approvalId']));
  const held = await holdAutomationAuthority(tx, context);
  if (held !== null) return held;
  const activationId = await approvalActivation(tx, request.approvalId);
  if (activationId === null) return refused(refuseNotFound(['approvalId']));
  const lost = await lockedAuthority(tx, context, activationId);
  if (lost !== null) return lost;
  const result = await revokeApproval(tx, {
    approvalId: request.approvalId,
    actorId: context.session.actorId,
  });
  if (result === 'unknown') return refused(refuseNotFound(['approvalId']));
  if (result === 'already_revoked') {
    return notPermitted('revoked', 'This approval is already revoked.');
  }
  const atCommit = await standsAtCommit(tx, context);
  if (atCommit !== null) return atCommit;
  return applied(request.approvalId, null, { approvalId: request.approvalId, revoked: true });
}
