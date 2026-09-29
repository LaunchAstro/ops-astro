// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals by person (C52-A, U36; CS-6.10). Red: the four commands
// are declared and refuse until they are built.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ActivationAdoptRequest,
  ActivationRollBackRequest,
  ActivationTurnOffRequest,
  ApprovalRevokeRequest,
} from './automation-requests.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

const notBuilt = (command: string): HandlerOutcome =>
  refused(refuseCommand('DEPENDENCY_NOT_LANDED', [command], ['C52-A: not built.']));

export async function adoptActivationVersion(
  _tx: TenantQuery,
  _context: CommandContext,
  request: ActivationAdoptRequest,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notBuilt(request.command));
}

export async function rollBackActivation(
  _tx: TenantQuery,
  _context: CommandContext,
  request: ActivationRollBackRequest,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notBuilt(request.command));
}

export async function turnOffActivationAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
  request: ActivationTurnOffRequest,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notBuilt(request.command));
}

export async function revokeStandingApproval(
  _tx: TenantQuery,
  _context: CommandContext,
  request: ApprovalRevokeRequest,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notBuilt(request.command));
}
