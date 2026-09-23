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
// Comments are stored and are not yet projected through the API: the read that
// serves them is L3's, built on `readTaskComments` and
// `externalCommentProjection` below.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isLive, type FieldDefinition } from '../records/fields.ts';
import type { SpineField } from './spine.ts';

/** The comment type's key, beside `task` and `task_state`. */
export const COMMENT_TYPE_KEY = 'task_comment';

/**
 * What kind of thing was said. `client` is written to be seen outside,
 * `note` is the team talking, `system` is the product narrating.
 */
export type CommentType = 'note' | 'client' | 'system';

/** Who it is for. The projection reads this and nothing else to decide. */
export type CommentAudience = 'internal' | 'client';

/**
 * The comment spine.
 *
 * `comment_type` and `audience` are two fields rather than one because they
 * answer two questions: a `system` comment can be addressed to a client, and a
 * `client` comment written in error can be re-addressed internally without
 * rewriting what it is. Collapsing them would make "who sees this" a property
 * of "what this is", which is the coupling that produces a leak when a new
 * kind arrives.
 */
export const COMMENT_SPINE: readonly SpineField[] = [
  {
    key: 'task',
    label: 'Task',
    valueType: 'uuid',
    slot: 'uuid_1',
    // The parent is established when the comment is written and never edited:
    // moving a comment between tasks is a different operation with a different
    // audit meaning, not a field edit.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'author',
    label: 'Author',
    valueType: 'uuid',
    slot: 'uuid_2',
    // Derived from the acting identity. Never a payload field, because a
    // comment whose author a caller can set is not evidence of anything.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'comment_type',
    label: 'Kind',
    valueType: 'text',
    slot: 'txt_1',
    writeMode: 'operation',
    owningOperations: ['task.comment'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'audience',
    label: 'Audience',
    valueType: 'text',
    slot: 'txt_2',
    // Two operations: the one that writes the comment, and the one that
    // changes who a task's correspondence is addressed to. A generic edit to
    // this field is the access change that looks like ordinary content, which
    // is exactly what `write_mode` exists to catch.
    writeMode: 'operation',
    owningOperations: ['task.comment', 'task.set_audience'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'body',
    label: 'Comment',
    valueType: 'text',
    slot: 'txt_3',
    writeMode: 'operation',
    owningOperations: ['task.comment'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'posted_at',
    label: 'Posted',
    valueType: 'timestamptz',
    slot: 'ts_1',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'edited_at',
    label: 'Edited',
    valueType: 'timestamptz',
    slot: 'ts_2',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'source',
    label: 'Source',
    valueType: 'text',
    slot: 'txt_4',
    // Which surface it arrived through. Internal: it tells an outside reader
    // about the shape of the system rather than about the work.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
];

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
}

export interface NewComment {
  readonly taskId: string;
  readonly authorActorId: string;
  readonly commentType: CommentType;
  readonly audience: CommentAudience;
  readonly body: string;
  readonly source: string;
}

interface CommentRow {
  readonly id: string;
  readonly data: Readonly<Record<string, string | null>>;
}

function storedFrom(row: CommentRow): StoredComment {
  const data = row.data;
  return {
    id: row.id,
    taskId: data['task'] ?? '',
    authorActorId: data['author'] ?? '',
    commentType: (data['comment_type'] ?? 'note') as CommentType,
    audience: (data['audience'] ?? 'internal') as CommentAudience,
    body: data['body'] ?? '',
    postedAt: new Date(data['posted_at'] ?? 0),
    editedAt:
      data['edited_at'] === undefined || data['edited_at'] === null
        ? null
        : new Date(data['edited_at']),
    source: data['source'] ?? '',
  };
}

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
    `insert into records (business_id, id, record_type_id, data)
     values ($1, $2, $3, jsonb_build_object(
       'task', $4::text, 'author', $5::text, 'comment_type', $6::text,
       'audience', $7::text, 'body', $8::text, 'source', $9::text,
       'posted_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')))`,
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
    ],
  );
  return id;
}

/** Every comment on one task, oldest first, with nothing filtered. Storage is not the allowlist. */
export async function readTaskComments(
  tx: TenantQuery,
  commentTypeId: string,
  taskId: string,
): Promise<readonly StoredComment[]> {
  const rows = await tx.query<CommentRow>(
    `select id, data from records
      where business_id = $1 and record_type_id = $2 and deleted_at is null
        and data ->> 'task' = $3
      order by data ->> 'posted_at', id`,
    [tx.businessId, commentTypeId, taskId],
  );
  return rows.map(storedFrom);
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
