// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.allowance` (AW-04, U10): the drawer's planning allowance line.
// It answers `readPlanningAllowance` (`core-custody/src/broker-planning.ts`):
// the business's planning cap, what is left of it across the business, and the
// caller's own conversation's settled spend and held amount.
//
// Who may read it is this module's rule, as the tab row's is:
//
// - the cap and what is left are the business's, a sum over every person's
//   planning replies, so the read is the team's (owner, administrator,
//   member: `isInternalReader`) holding `conversation:write`, the drawer's
//   own key; a client, a member with no drawer and anyone else are refused
//   `SCOPE_NOT_GRANTED` before any figure is read;
// - the conversation is optional: none is the empty drawer, before the first
//   message, and reads nothing spent; one that is named must be the caller's
//   own in this business, and anything else (another person's, another
//   business's, a made-up id) is `NOT_FOUND`, the same bytes for each. The
//   spend is also filtered by its owner inside the broker's query.

// RED STUB (SL11-27 fork L): the read refuses every caller until the build commit.
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { AllowanceResult } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

const NOT_THE_TEAMS = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  [
    'The planning allowance is the business’s own team’s, read from their conversations with the agent (conversation:write).',
    'Ask an administrator who may grant it.',
  ],
);

export async function readAllowance(
  _tx: TenantQuery,
  _session: Session,
  _conversationId: unknown,
): Promise<AllowanceResult | CommandRefusal> {
  return await Promise.resolve(NOT_THE_TEAMS);
}
