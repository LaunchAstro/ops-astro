// SPDX-License-Identifier: AGPL-3.0-only
//
// `model.call` on the person prefix. Its own module, apart from the broker's
// executor, so the person handlers never import the agent entry.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const PERSON_FIXES: readonly string[] = [
  "A model call is the run's worker's, made under its lease through the credential broker.",
];

/** A person holding a lease has no route to the broker (AW-01, "n/a (system)"). */
export function refuseModelCallAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
): Promise<HandlerOutcome> {
  return Promise.resolve(refused(refuseCommand('SCOPE_NOT_GRANTED', ['model.call'], PERSON_FIXES)));
}
