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

import { checkAuthority, isUuid, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { readPlanningAllowance } from '../../../core-custody/src/index.ts';
import type { AllowanceResult } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

const NOT_THE_TEAMS = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  [
    'The planning allowance is the business’s own team’s, read from their conversations with the agent (conversation:write).',
    'Ask an administrator who may grant it.',
  ],
);

export async function readAllowance(
  tx: TenantQuery,
  session: Session,
  conversationId: unknown,
): Promise<AllowanceResult | CommandRefusal> {
  if (!isInternalReader(session.roleKey)) return NOT_THE_TEAMS;
  const own = await checkAuthority(tx, subjectsOf(session), {
    collection: 'conversation',
    action: 'write',
    scope: { kind: 'business', id: null },
  });
  if (!own.ok) return NOT_THE_TEAMS;
  if (conversationId === undefined || conversationId === null) {
    return { ok: true, allowance: await readPlanningAllowance(tx, session.personId, null) };
  }
  if (!isUuid(conversationId)) {
    return refuseCommand(
      'FIELD_VALUE_INVALID',
      ['conversationId'],
      ['Send conversationId as your conversation’s identifier, or leave it out.'],
    );
  }
  const mine = await tx.query<{ readonly id: string }>(
    `select id from conversations where business_id = $1 and id = $2 and owner_actor_id = $3`,
    [tx.businessId, conversationId, session.actorId],
  );
  if (mine.length === 0) return refuseNotFound();
  return {
    ok: true,
    allowance: await readPlanningAllowance(tx, session.personId, conversationId),
  };
}
