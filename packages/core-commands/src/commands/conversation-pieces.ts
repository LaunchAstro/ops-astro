// SPDX-License-Identifier: AGPL-3.0-only
//
// The authority a person's answer is heard under, written once for both ways
// it is heard: kept as the reply (`conversation-exchange.ts`, `keep`), and
// handed on piece by piece while the model writes it (`judgedPieces`).
//
// Each judgement runs in a transaction of its own, after its locks: the
// conversation's row (still the caller's, its body not purged), the session
// not ended (an ending in flight waits for it), and the caller's conversation
// grants held for share and judged at the instant after those locks. What it
// allows is done inside that transaction, so a revocation, an ending or a
// purge that commits first is seen and stops it, and one that comes later
// waits until it is done.

import { sessionEndedSince, subjectsOf, withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { holdCoveringGrants, lockedInstant } from '../../../core-runtime/src/index.ts';
import { holdsOwnConversations } from './conversations.ts';

/** The message a person just kept, from the applied command's detail. */
export interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

/**
 * The instant after the locks, while the caller may still hear the answer to
 * their message; undefined when they may not. `update` takes the conversation
 * as a reply's keep does; `share` lets two judgements run together.
 *
 * The grants are held `nowait`, because the trash purge locks grants before
 * conversations: one being changed now refuses (55P03, `heldElsewhere`). The
 * check rests on a grant held here, so one issued after the hold does not count.
 */
export async function hearingAt(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  lock: 'update' | 'share',
): Promise<string | undefined> {
  const [conversation] = await tx.query<{ readonly body_purged_at: Date | null }>(
    `select body_purged_at from conversations
      where business_id = $1 and id = $2 and owner_actor_id = $3
      for ${lock === 'update' ? 'update' : 'share'}`,
    [tx.businessId, asked.conversationId, session.actorId],
  );
  if (conversation === undefined || conversation.body_purged_at !== null) return undefined;
  // Asked before the grants, so the grant is judged at the clock after this wait too.
  if (await sessionEndedSince(tx, session)) return undefined;
  const held = new Set(await holdCoveringGrants(tx, subjectsOf(session), 'conversation', 'nowait'));
  const at = await lockedInstant(tx);
  return (await holdsOwnConversations(tx, session, { at, held })) ? at : undefined;
}

/** A grant being changed under a `nowait` hold: the transaction rolled back, nothing done. */
export function heldElsewhere(cause: unknown): undefined {
  if ((cause as { readonly code?: unknown }).code !== '55P03') throw cause;
  return undefined;
}

export interface JudgedPieces {
  /** One display text, handed on once a judgement allows it. */
  readonly push: (text: string) => void;
  /** Resolves once every text pushed so far is handed on or dropped. */
  readonly drained: () => Promise<void>;
}

/**
 * Pieces handed on to `onPiece` only while the caller may hear the answer:
 * each batch is judged as above and handed on inside its judgement. Texts
 * that arrive during a judgement wait for the next, so one runs at a time.
 * Once a judgement refuses, or cannot be made, nothing more is handed on.
 */
export function judgedPieces(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
  onPiece: (text: string) => void,
): JudgedPieces {
  let waiting: string[] = [];
  let stopped = false;
  let turn = Promise.resolve();
  const judgeTurn = async (): Promise<void> => {
    while (waiting.length > 0 && !stopped) {
      const batch = waiting;
      waiting = [];
      // oxlint-disable-next-line no-await-in-loop -- one judgement at a time, in order
      const handed = await withSession(database, businessId, presented, async (tx, session) => {
        if ((await hearingAt(tx, session, asked, 'share')) === undefined) return false;
        for (const text of batch) onPiece(text);
        return true;
      }).catch((cause: unknown) => heldElsewhere(cause));
      if (handed !== true) stopped = true;
    }
  };
  return {
    push: (text) => {
      if (stopped) return;
      waiting.push(text);
      if (waiting.length === 1)
        turn = turn.then(judgeTurn).catch(() => {
          stopped = true;
        });
    },
    drained: async () => {
      await turn;
    },
  };
}
