// SPDX-License-Identifier: AGPL-3.0-only
//
// `connector.repair` (MP-14-7a): record `connector repair started`.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

export async function startConnectorRepair(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly connectionId: string; readonly expectedRevision?: unknown },
): Promise<HandlerOutcome> {
  return await Promise.resolve(
    refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['connector.repair'], ['Not built yet.'])),
  );
}
