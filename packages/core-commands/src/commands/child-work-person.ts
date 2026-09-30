// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11's hand-over and handback on the person prefix. Their own module, apart
// from the agent's (`agent-child.ts`), so the person handlers never import the
// agent entry.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

/** Red: not built. */
export function refuseChildWorkAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
): Promise<HandlerOutcome> {
  return Promise.resolve(
    refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['child work: not built'], [])),
  );
}
