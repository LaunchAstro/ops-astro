// SPDX-License-Identifier: AGPL-3.0-only
//
// Team conversations, the direct half (C71-D, CS-7.25, CS-7.26).
//
// `chat.send_direct`: a direct message to a teammate is a comment on the one
// comment record, written by the comment writer `task.comment` uses
// (`writeComment`) with the audience `direct`, anchored to the pair's one
// conversation instead of a task. The envelope has already asked `chat:comment`
// and writes its audit event, `comment created (audience: direct)`, in this
// transaction; the event records that a message was sent, never what it says.
// Staff only: a client's person, an agent and the sender themselves are not a
// teammate to write to, and every such name gets the one NOT_FOUND.
// Sending moves the sender's own read marker (R36).
//
// **Authority is read again after the last lock wait.** The door admitted the
// caller before the pair and conversation locks, and a wait there can outlast
// a revocation. So both writes take the business's access lock, shared, after
// their conversation locks and read the sender's or reader's membership, the
// grant and the recipient's staff membership again under it. A revocation or
// an ended access takes it exclusively first (`lockAccess`), so it committed
// before this read, which then refuses with the door's own code, or waits for
// this write to commit. Lock order: pair, conversation, access; nothing that
// holds the access lock takes a conversation's. A conversation the send has
// just started goes with the refusal (the envelope's savepoint).
//
// `chat.mark_read`: the reader's own marker on a conversation they are in,
// moved to the newest message they saw and never back. Their own member row
// only, no grant asked, and not audited (CS-7.25): anyone else's conversation
// is NOT_FOUND.

import {
  checkAuthority,
  directConversation,
  isStaff,
  lockConversation,
  moveReadMarker,
  readPositionOf,
  NO_MEMBERSHIP_FIXES,
  readConversationTypes,
  shareAccessLock,
  subjectsOf,
  writeComment,
  type ConversationTypes,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { commentBodyOf, NO_COMMENT_TYPE_FIXES } from './tasks-comment.ts';

const UP_TO_FIXES: readonly string[] = [
  'Send upTo as the newest message you read, its `at` exactly as chat.messages gave it.',
];

export async function sendDirect(
  tx: TenantQuery,
  context: CommandContext,
  teammateId: string,
  body: unknown,
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(refuseNotFound());
  const words = commentBodyOf(body);
  if (typeof words !== 'string') return words;
  const types = await conversationTypesFor(tx, context);
  if (!('conversationTypeId' in types)) return types;
  if (teammateId.toLowerCase() === session.personId || !(await isStaff(tx, teammateId))) {
    return refused(refuseNotFound());
  }
  const conversationId = await directConversation(
    tx,
    types,
    session.personId,
    teammateId.toLowerCase(),
  );
  const lost = await standsNow(tx, context, teammateId.toLowerCase());
  if (lost !== undefined) return refused(lost);
  return await writeMessage(tx, context, types, conversationId, 'direct', words);
}

/**
 * A message into a conversation whose lock the caller holds: a comment on the
 * one comment record with the conversation's audience, then the sender's own
 * marker past it (R36). The one path for a direct and a group message.
 */
export async function writeMessage(
  tx: TenantQuery,
  context: CommandContext,
  types: ConversationTypes,
  conversationId: string,
  audience: 'direct' | 'group',
  words: string,
): Promise<HandlerOutcome> {
  const commentId = await writeComment(tx, types.commentTypeId, {
    taskId: null,
    conversationId,
    authorActorId: context.session.actorId,
    commentType: 'note',
    audience,
    body: words,
    source: context.entryPoint,
  });
  await moveReadMarker(tx, conversationId, context.session.personId, 'now');
  return applied(conversationId, null, { conversationId, commentId });
}

/** The conversation types, or the refusal a business without them is owed. */
export async function conversationTypesFor(
  tx: TenantQuery,
  context: CommandContext,
): Promise<ConversationTypes | HandlerOutcome> {
  const types = await readConversationTypes(tx);
  return (
    types ??
    refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        [context.declaration.name, 'team_conversation'],
        NO_COMMENT_TYPE_FIXES,
      ),
    )
  );
}

export async function markOwnRead(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
  upTo: unknown,
): Promise<HandlerOutcome> {
  if (!isInternalReader(context.session.roleKey)) return refused(refuseNotFound());
  const position = readPositionOf(upTo);
  if (position === undefined) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['upTo'], UP_TO_FIXES));
  }
  // The key in the form a send takes it: one conversation, one lock.
  const key = conversationId.toLowerCase();
  await lockConversation(tx, key);
  const lost = await standsNow(tx, context, null);
  if (lost !== undefined) return refused(lost);
  return (await moveReadMarker(tx, key, context.session.personId, position))
    ? applied(null, null, { conversationId })
    : refused(refuseNotFound());
}

/**
 * The caller's standing read again under the access lock (shared), after
 * every lock wait the write takes: membership first, as the door asks it,
 * then the declaration's grant (none for the reader's own marker), then the
 * recipient is still staff. Nothing, or the refusal the next call would get.
 */
export async function standsNow(
  tx: TenantQuery,
  context: CommandContext,
  recipientId: string | null,
): Promise<CommandRefusal | undefined> {
  const { session, declaration } = context;
  await shareAccessLock(tx);
  if (!(await isStaff(tx, session.personId))) {
    return refuseCommand('AUTH_NO_MEMBERSHIP', [], NO_MEMBERSHIP_FIXES);
  }
  if (declaration.authorisedOn !== 'self') {
    const granted = await checkAuthority(tx, subjectsOf(session), {
      collection: declaration.collection,
      action: declaration.action,
      scope: { kind: 'business', id: null },
    });
    if (!granted.ok) return granted.refusal;
  }
  if (recipientId !== null && !(await isStaff(tx, recipientId))) return refuseNotFound();
  return undefined;
}
