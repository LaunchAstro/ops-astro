// SPDX-License-Identifier: AGPL-3.0-only
//
// A task conversation's thread (MP-4-5, R42, CS-4.34): one comment locked
// through its task, an author's rewrite and delete, and the signal each
// top-level client message carries. The comment type and its projection are
// `comments.ts`'s.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';
import {
  COMMENT_COLUMNS,
  NOW_TEXT,
  storedFrom,
  type CommentRow,
  type StoredComment,
} from './comments.ts';

/**
 * One live comment on one task, locked for the rest of the transaction, or
 * nothing. The task is part of the filter: a comment is reached through the
 * task the caller was authorised on and no other, so a comment id from
 * another task or business reads as absent.
 */
export async function lockComment(
  tx: TenantQuery,
  commentTypeId: string,
  taskId: string,
  commentId: string,
): Promise<StoredComment | undefined> {
  if (!isUuid(commentId)) return undefined;
  const rows = await tx.query<CommentRow>(
    `select ${COMMENT_COLUMNS} from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.id = $3
        and r.data ->> 'task' = $4 and r.deleted_at is null
      for update of r`,
    [tx.businessId, commentTypeId, commentId, taskId],
  );
  const row = rows[0];
  return row === undefined ? undefined : storedFrom(row);
}

/** A comment's new words and the server's time of the edit. The caller holds its lock. */
export async function rewriteComment(
  tx: TenantQuery,
  commentTypeId: string,
  commentId: string,
  body: string,
): Promise<void> {
  await tx.query(
    `update public.records
        set data = data || jsonb_build_object('body', $4::text, 'edited_at', ${NOW_TEXT})
      where business_id = $1 and record_type_id = $2 and id = $3`,
    [tx.businessId, commentTypeId, commentId, body],
  );
}

/**
 * A comment deleted by its author: out of every read, kept in storage like a
 * trashed task, by whom and in a batch of its own (`records_trash_is_whole`).
 * The batch identity is minted here and returned to nobody: a comment is not
 * restored through `task.restore`. Its replies stay; the page draws them
 * under a line saying the message was deleted. The caller holds its lock.
 */
export async function removeComment(
  tx: TenantQuery,
  commentTypeId: string,
  commentId: string,
  actorId: string,
): Promise<void> {
  await tx.query(
    `update public.records
        set deleted_at = now(), deleted_by_actor_id = $4, trash_batch_id = $5
      where business_id = $1 and record_type_id = $2 and id = $3`,
    [tx.businessId, commentTypeId, commentId, actorId, randomUUID()],
  );
}

/** Where a top-level client message stands (DT-19, R42). */
export type CommentSignal = 'answered' | 'owed' | 'not_acknowledged';

/**
 * Each top-level client message's signal, derived from the thread as read.
 *
 * The side that owes the answer is the other side: a message from the
 * client's people is owed a reply from the team, and is `answered` once one
 * of the team replies to it (a general message on the Client tab is not an
 * answer, XC D9); the team's message is `not_acknowledged` until one of the
 * client's people replies to it. Seen needs a client read receipt, which the
 * portal records, so nothing here says it yet. Internal notes and replies
 * carry no signal.
 */
export function commentSignals(
  comments: readonly StoredComment[],
): ReadonlyMap<string, CommentSignal> {
  const signals = new Map<string, CommentSignal>();
  for (const message of comments) {
    if (message.audience !== 'client' || message.parentId !== null) continue;
    const answered = comments.some(
      (reply) => reply.parentId === message.id && reply.fromOutside !== message.fromOutside,
    );
    signals.set(
      message.id,
      answered ? 'answered' : message.fromOutside ? 'owed' : 'not_acknowledged',
    );
  }
  return signals;
}
