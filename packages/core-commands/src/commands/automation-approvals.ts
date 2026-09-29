// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals by person (C52-A, U36; CS-6.10). The envelope has already
// checked `automation:manage` business-wide and refused every agent. What is
// left is the value, then the identifiers, where another business's row
// answers exactly as a fabricated one does (row security hides it).
//
// An adoption pins an exact released version and is that pin's standing
// approval; a rollback is an adoption of the version numbered just below the
// pin, and the newer version and the earlier adoption stay in history.
// Revoking an approval is its own act and leaves the pin; turning an
// automation off ends its approval with it. Each change is compared with the
// revision the caller read under the activation's lock (`approvals.ts`), so a
// claim, a dispatch and these changes take turns.

import {
  adoptVersion,
  isUuid,
  previousVersion,
  readActivation,
  readVersion,
  revokeApproval,
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
import { invalid, isRevision, notPermitted, staleAt } from './automations.ts';
import type { CommandContext } from './context.ts';
import { refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const unknownActivation = (): HandlerOutcome => refused(refuseNotFound(['activationId']));

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

async function adopt(
  tx: TenantQuery,
  context: CommandContext,
  current: ActivationRow,
  to: { readonly version: DefinitionVersionRow; readonly act: AdoptionAct },
): Promise<HandlerOutcome> {
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
  const current = await activationAt(tx, request.activationId, request.expectedRevision);
  if (isOutcome(current)) return current;
  const version = await previousVersion(tx, current.id);
  if (version === null) {
    return notPermitted(
      'versionId',
      'The pinned version is the first; there is none to roll back to.',
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
  const result = await revokeApproval(tx, {
    approvalId: request.approvalId,
    actorId: context.session.actorId,
  });
  if (result === 'unknown') return refused(refuseNotFound(['approvalId']));
  if (result === 'already_revoked') {
    return notPermitted('revoked', 'This approval is already revoked.');
  }
  return applied(request.approvalId, null, { approvalId: request.approvalId, revoked: true });
}
