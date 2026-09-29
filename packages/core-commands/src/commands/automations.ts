// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33): not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

const notYet = (): HandlerOutcome =>
  refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['C33'], ['not built yet']));

export async function changeActivationAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: object,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notYet());
}

export async function releaseDefinitionVersion(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: object,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notYet());
}
