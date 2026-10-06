// SPDX-License-Identifier: AGPL-3.0-only
//
// A comment's mentions: the list it names, and the refusal of names that
// cannot read it. Shared by `task.comment` (`tasks-comment.ts`, which
// re-exports both) and a team conversation's message (C71, `chat.ts`); moved
// out of `tasks-comment.ts` whole for its line cap.

import { seenBy, type Mentioned, type TenantQuery } from '../../../core-records/src/index.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { refused, type HandlerOutcome, type Refused } from './outcome.ts';

const MENTIONS_FIXES: readonly string[] = [
  'Send mentions as a list of person ids, or leave it out.',
];

/**
 * The refusal of mentions that cannot read the comment. It names each person
 * only to an author who could already see them (`seenBy`), and otherwise gives
 * back the identifier exactly as sent: its stored letter case would say it exists.
 * The register keeps the identifiers-only form, so a replay names nobody the
 * author may no longer see.
 * A team conversation's message (C71) is refused by it too.
 */
export async function unreadableMentions(
  tx: TenantQuery,
  authorActorId: string,
  named: readonly string[],
  unreadable: readonly Mentioned[],
): Promise<Refused> {
  const ids = unreadable.map((person) => person.personId);
  const seen = await seenBy(tx, authorActorId, ids);
  const sent = new Map(named.map((id) => [id.toLowerCase(), id] as const));
  const asSent = (person: Mentioned): string =>
    sent.get(person.personId.toLowerCase()) ?? person.personId;
  const refusal = (shown: (person: Mentioned) => string): CommandRefusal =>
    refuseCommand(
      'MENTION_NOT_READABLE',
      ['mentions'],
      unreadable.map((person) => `${shown(person)} cannot read this comment: remove the mention.`),
    );
  return {
    refusal: refusal((person) => (seen.has(person.personId) ? person.label : asSent(person))),
    kept: refusal(asSent),
  };
}

/** The people a comment names, or its refusal: a list of person ids, absent meaning none. */
export function mentionsOf(mentions: unknown): readonly string[] | HandlerOutcome {
  const named = mentions ?? [];
  if (!Array.isArray(named) || !named.every((id): id is string => isIdentifier(id))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['mentions'], MENTIONS_FIXES));
  }
  return named;
}
