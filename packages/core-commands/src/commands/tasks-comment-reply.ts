// SPDX-License-Identifier: AGPL-3.0-only
//
// A reply's parent in a task conversation (MP-4-5), for `task.comment` in
// `tasks-comment.ts`: one level deep, in the message's audience, and never a
// way to learn that a message the caller may not write in exists.

import { lockComment, type TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

/** What the reply check reads of the comment being written. */
export interface ReplyTarget {
  readonly commentTypeId: string;
  readonly target: { readonly id: string };
  readonly audiences: ReadonlySet<string>;
}

const PARENT_FIXES: readonly string[] = [
  'Send parentId as the id of a message on this task, or leave it out for a new message.',
  'Replies are one level deep: reply to the message, not to a reply.',
];

const REPLY_AUDIENCE_FIXES: readonly string[] = [
  'A reply goes to the audience of the message it answers.',
];

/**
 * The message a reply sits under, locked through its task: its id, null for a
 * new message, or the refusal. One level deep, and in the message's audience.
 */
export async function replyParent(
  tx: TenantQuery,
  on: ReplyTarget,
  parentId: unknown,
  audience: string,
): Promise<string | null | HandlerOutcome> {
  if (parentId === undefined || parentId === null) return null;
  const message =
    typeof parentId === 'string'
      ? await lockComment(tx, on.commentTypeId, on.target.id, parentId)
      : undefined;
  // A message in an audience this caller may not write in (an internal note,
  // to a client's person or an agent) is answered as one that is not there,
  // so a reply cannot reveal that a note it cannot see exists.
  if (message === undefined || message.parentId !== null || !on.audiences.has(message.audience)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['parentId'], PARENT_FIXES));
  }
  if (message.audience !== audience) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['audience'], REPLY_AUDIENCE_FIXES));
  }
  return message.id;
}
