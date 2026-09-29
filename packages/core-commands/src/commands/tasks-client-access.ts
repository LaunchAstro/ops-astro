// SPDX-License-Identifier: AGPL-3.0-only
//
// Client access (MP-4-10, CS-4.10, R45). Not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

export async function shareWithClient(
  _tx: TenantQuery,
  _context: CommandContext,
): Promise<HandlerOutcome> {
  return await Promise.resolve(refused(refuseCommand('NOT_FOUND', [], ['not built yet'])));
}

export async function revokeClientShare(
  _tx: TenantQuery,
  _context: CommandContext,
): Promise<HandlerOutcome> {
  return await Promise.resolve(refused(refuseCommand('NOT_FOUND', [], ['not built yet'])));
}
