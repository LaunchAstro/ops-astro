// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11's hand-over and handback on the person prefix. Their own module, apart
// from the agent's (`agent-child.ts`), so the person handlers never import the
// agent entry.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const PERSON_FIXES: readonly string[] = [
  "A hand-over and its handback are the run's agents', made on the agent prefix under the parent's lease.",
];

/** A person holding a lease has no route to either (AW-11, "n/a (system)"). */
export function refuseChildWorkAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
  request: { readonly command: 'run.delegate_child' | 'run.child_handback' },
): Promise<HandlerOutcome> {
  return Promise.resolve(
    refused(refuseCommand('SCOPE_NOT_GRANTED', [request.command], PERSON_FIXES)),
  );
}
