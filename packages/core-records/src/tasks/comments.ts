// SPDX-License-Identifier: AGPL-3.0-only
//
// The comment record type, its classifications, and the projection a client
// is shown.
//
// A comment is a record of its own type, not a column on a task and not a
// table. That is the same argument the task spine rests on: the set of fields
// is data, a preset can extend it, and the classification lives on the field
// definition where every surface inherits it (minimum contract 5.1).
//
// Nothing here is generic. A comment is not a form: the body and its
// classification belong to `task.comment`, and everything else is derived. The
// records engine refuses a generic write to all of it without being told, and
// the conformance set reads the classifications back.
//
// **The projection is an allowlist, and its direction is the point.** I09 asks
// that an external reader sees shared fields and client comments only, and its
// negative is an internal field reaching the HTTP body while the interface
// hides it. A projection built by removing what should not be there is one
// forgotten field away from that. This one includes what the catalogue marks
// `shared`, so a field nobody classified is absent rather than exposed.
//
// A task read returns an internal reader every comment in full and an external
// reader the allowlisted client projection. That read is the command layer's
// (`core-commands/src/reads/tasks.ts`), built on `readTaskComments` and
// `externalCommentProjection` below.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isLive, type FieldDefinition } from '../records/fields.ts';

export { COMMENT_SPINE } from './comment-spine.ts';

/** The comment type's key, beside `task` and `task_state`. */
export const COMMENT_TYPE_KEY = 'task_comment';

/**
 * What kind of thing was said. `client` is written to be seen outside,
 * `note` is the team talking, `system` is the product narrating.
 */
export type CommentType = 'note' | 'client' | 'system';

/**
 * Who it is for. The projection reads this and nothing else to decide. A
 * team conversation's message (C71) is `direct` (its two members) or `group`
 * (its members): never a task's, and never shown outside.
 */
export type CommentAudience = 'internal' | 'client' | 'direct' | 'group';

export interface StoredComment {
  readonly id: string;
  readonly taskId: string;
  readonly authorActorId: string;
  readonly commentType: CommentType;
  readonly audience: CommentAudience;
  readonly body: string;
  readonly postedAt: Date;
  readonly editedAt: Date | null;
  readonly source: string;
  /** The top-level message this replies to, or null for a message. */
  readonly parentId: string | null;
  /** The person an agent wrote it for; null when a person wrote their own. */
  readonly onBehalfOfPersonId: string | null;
  /**
   * Written by a person outside the business (no active membership): one of
   * the client's people. Read from the author's actor at read time, never
   * stored, so the signals below follow the membership as it stands.
   */
  readonly fromOutside: boolean;
}

export interface NewComment {
  /** The task it is on, or null for a team conversation's message. */
  readonly taskId: string | null;
  /** The team conversation it is in (C71); absent on a task's comment. */
  readonly conversationId?: string;
  readonly authorActorId: string;
  readonly commentType: CommentType;
  readonly audience: CommentAudience;
  readonly body: string;
  readonly source: string;
  /** The top-level message a reply sits under; absent or null for a message. */
  readonly parentId?: string | null;
  /** The person an agent writes it for; absent or null for a person. */
  readonly onBehalfOfPersonId?: string | null;
}

/** The server's now, as the ISO text a comment's times are stored in. */
export const NOW_TEXT: string = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')`;

/**
 * A conversation message's time and place, read under its lock (conversations.ts):
 * the wall clock, so a send that waited is stamped after the one before, and
 * `created_at`, a strict order of writes that ranks one millisecond's messages.
 */
const CLOCK_TEXT = `to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')`;
const CONVERSATION_ORDER = `(select greatest(clock_timestamp(), max(c.created_at) + interval '1 microsecond')
  from records c where c.business_id = $1 and c.record_type_id = $3 and c.uuid_4 = ($11::text)::uuid and c.deleted_at is null)`;

/**
 * Write one comment, inside the caller's transaction.
 *
 * The timestamp is the server's, not the caller's: a comment whose posting
 * time a client can choose is a comment that can be inserted into the past.
 * `task.comment` commits its comment with its own success identity before any
 * downstream notification work; nothing here invokes a provider.
 */
export async function writeComment(
  tx: TenantQuery,
  commentTypeId: string,
  comment: NewComment,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into records (business_id, id, record_type_id, data, created_at)
     values ($1, $2, $3, jsonb_strip_nulls(jsonb_build_object(
       'task', $4::text, 'author', $5::text, 'comment_type', $6::text,
       'audience', $7::text, 'body', $8::text, 'source', $9::text,
       'posted_at', ${comment.conversationId === undefined ? NOW_TEXT : CLOCK_TEXT}, 'parent', $10::text, 'conversation', $11::text, 'on_behalf_of', $12::text)), ${comment.conversationId === undefined ? 'now()' : CONVERSATION_ORDER})`,
    [
      tx.businessId,
      id,
      commentTypeId,
      comment.taskId,
      comment.authorActorId,
      comment.commentType,
      comment.audience,
      comment.body,
      comment.source,
      comment.parentId ?? null,
      comment.conversationId ?? null,
      comment.onBehalfOfPersonId ?? null,
    ],
  );
  return id;
}

/** The stored value of one field, by its key, so the projection can be catalogue-driven. */
const VALUE_OF: Readonly<Record<string, (comment: StoredComment) => unknown>> = {
  task: (comment) => comment.taskId,
  author: (comment) => comment.authorActorId,
  comment_type: (comment) => comment.commentType,
  audience: (comment) => comment.audience,
  body: (comment) => comment.body,
  posted_at: (comment) => comment.postedAt,
  edited_at: (comment) => comment.editedAt,
  source: (comment) => comment.source,
  parent: (comment) => comment.parentId,
  on_behalf_of: (comment) => comment.onBehalfOfPersonId,
};

/**
 * What an external reader is shown: client comments, in shared fields.
 *
 * Both halves are allowlists. The comments are the ones addressed to the
 * client — an internal note is absent from the body, not hidden in it. The
 * fields are the ones the catalogue marks `shared`, read from the definitions
 * the caller passes rather than from a list held here, so classifying a field
 * is the only way to expose it and un-classifying one removes it.
 *
 * `id` is always present: an external reader needs to be able to refer to a
 * comment, and the identifier is the caller's own record's.
 */
export function externalCommentProjection(
  comments: readonly StoredComment[],
  fields: readonly FieldDefinition[],
): readonly Readonly<Record<string, unknown>>[] {
  const shared = fields.filter((field) => isLive(field) && field.visibilityClass === 'shared');
  return comments
    .filter((comment) => comment.audience === 'client')
    .map((comment) => {
      const projected: Record<string, unknown> = { id: comment.id };
      for (const field of shared) {
        const read = VALUE_OF[field.key];
        if (read !== undefined) projected[field.key] = read(comment);
      }
      return projected;
    });
}
