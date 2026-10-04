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
// A message's `mentions` (CS-7.42) take a task comment's path: each person
// named must be a current member of the conversation, or the message is
// refused `MENTION_NOT_READABLE` before it saves, and each is raised a
// `mention` inbox item about the conversation (`raiseMentions`), never the
// author. Nothing is emailed here: email is the batched mention rule's.
//
// `chat.mark_read`: the reader's own marker on a conversation they are in,
// moved to the newest message they saw and never back. Their own member row
// only, no grant asked, and not audited (CS-7.25): anyone else's conversation
// is NOT_FOUND.

import {
  directConversation,
  isStaff,
  moveReadMarker,
  raiseMentions,
  readConversationMentions,
  readConversationTypes,
  writeComment,
  type ConversationTypes,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import {
  commentBodyOf,
  mentionsOf,
  NO_COMMENT_TYPE_FIXES,
  unreadableMentions,
} from './tasks-comment.ts';

const UP_TO_FIXES: readonly string[] = [
  'Send upTo as the time of the newest message you read, as ISO text.',
];

export async function sendDirect(
  tx: TenantQuery,
  context: CommandContext,
  teammateId: string,
  body: unknown,
  mentions?: unknown,
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(refuseNotFound());
  const words = commentBodyOf(body);
  if (typeof words !== 'string') return words;
  const named = mentionsOf(mentions);
  if (!Array.isArray(named)) return named as HandlerOutcome;
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
  return await writeMessage(tx, context, types, conversationId, 'direct', words, named);
}

/**
 * A message into a conversation whose lock the caller holds: a comment on the
 * one comment record with the conversation's audience, its mentions raised,
 * then the sender's own marker past it (R36). The one path for a direct and a
 * group message.
 */
export async function writeMessage(
  tx: TenantQuery,
  context: CommandContext,
  types: ConversationTypes,
  conversationId: string,
  audience: 'direct' | 'group',
  words: string,
  named: readonly string[],
): Promise<HandlerOutcome> {
  const authorActorId = context.session.actorId;
  const mentioned = await readConversationMentions(tx, conversationId, named);
  const unreadable = mentioned.filter((person) => !person.readable);
  if (unreadable.length > 0) {
    return refused(await unreadableMentions(tx, authorActorId, named, unreadable));
  }
  const commentId = await writeComment(tx, types.commentTypeId, {
    taskId: null,
    conversationId,
    authorActorId,
    commentType: 'note',
    audience,
    body: words,
    source: context.entryPoint,
  });
  // The inbox item is about the conversation: its members alone are shown it.
  // It is raised when the message is posted, under the lock, so a member who
  // reads the message (joined by then) is shown its mention too.
  const posted = await tx.query<{ readonly at: string }>(
    'select ts_1::text as at from public.records where business_id = $1 and id = $2',
    [tx.businessId, commentId],
  );
  const postedAt = posted[0]?.at;
  const about = { taskId: conversationId, commentId, authorActorId, audience, postedAt };
  await raiseMentions(tx, about, mentioned);
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
  const at = typeof upTo === 'string' ? new Date(upTo) : undefined;
  if (at === undefined || Number.isNaN(at.getTime())) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['upTo'], UP_TO_FIXES));
  }
  return (await moveReadMarker(tx, conversationId, context.session.personId, at))
    ? applied(null, null, { conversationId })
    : refused(refuseNotFound());
}
