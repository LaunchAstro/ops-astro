// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.edit_comment` and `task.delete_comment`: an author rewrites or deletes
// their own message or reply (MP-4-5, CS-4.34, R42).
//
// Both target the task, not the comment, so the envelope's check of the
// `comment` grant, its lock on the task and its audit event are the ones
// `task.comment` has, on both entries; the comment is `commentId`, read
// through that task under its own lock (`lockComment`). A comment on another
// task, in another business, or already deleted is `NOT_FOUND`; someone
// else's is `SCOPE_NOT_GRANTED`, whoever they are, because holding `comment`
// on a task is the right to speak on it, not to rewrite what others said. An
// agent reaches here inside its delegation on its own task and edits only
// what its own actor wrote for the person that delegation acts for: one agent
// actor speaks for many people, so a comment it wrote for P is P's to correct,
// not Q's (OW-036.1). An agent credential's comment records its person the
// same way. A person's own comment carries no such person.
//
// An edit may name the `edited_at` it was typed against (`expectedEditedAt`,
// null for words never edited). The comment's own lock orders two edits, so
// the second one re-reads the first's stamp and is refused `VERSION_STALE`
// rather than silently replacing words its author never saw. An edit naming
// none replaces whatever is there.

import { lockComment, removeComment, rewriteComment } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import type { CommandContext, TaskRow } from './context.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseUnstorable, storableText } from './values.ts';
import { NO_COMMENT_TYPE_FIXES, representedPerson } from './tasks-comment.ts';

const BODY_FIXES: readonly string[] = [
  'Send a body with something in it. To take the words back, delete the message.',
];

const NOT_AUTHOR_FIXES: readonly string[] = ['Only its author edits or deletes a message.'];

const EDITED_AT_FIXES: readonly string[] = [
  'Send expectedEditedAt as the edited_at task.read gave the message, or null if it gave none.',
];

const STALE_EDIT_FIXES: readonly string[] = [
  'The message was edited since you read it. Read the task again and edit what it says now.',
];

/** What a comment change is made against, from whichever envelope reached it. */
export interface CommentChange {
  readonly commentTypeId: string | undefined;
  readonly declaration: CommandDeclaration;
  /** The task, as its envelope locked it. */
  readonly target: TaskRow;
  readonly actorId: string;
  /** The person the caller acts for as an agent (delegation or credential); `null` for a person. */
  readonly onBehalfOfPersonId: string | null;
  /**
   * The agent entry's authority asked again once the comment is locked, so a
   * delegation or covering grant revoked while the change waited on a lock
   * refuses it (OW-036.1 criterion 5); absent on the person entry.
   */
  readonly stillAuthorised?: () => Promise<CommandRefusal | undefined>;
}

/** The person entry's change, from its command context. */
export function changeFrom(context: CommandContext): CommentChange {
  const target = context.target;
  if (target === undefined) {
    throw new Error('comment change: reached without the task the declaration targets');
  }
  return {
    commentTypeId: context.spine.taskCommentTypeId,
    declaration: context.declaration,
    target,
    actorId: context.session.actorId,
    onBehalfOfPersonId: representedPerson(context.session),
  };
}

/**
 * The caller's own live comment on this task, locked, or the refusal. Every
 * refusal returns before anything is written.
 */
async function ownComment(
  tx: TenantQuery,
  on: CommentChange,
  commentId: unknown,
): Promise<
  | { readonly typeId: string; readonly id: string; readonly editedAt: string | null }
  | HandlerOutcome
> {
  if (on.target.deleted_at !== null) return refused(refuseNotFound());
  const typeId = on.commentTypeId;
  if (typeId === undefined) {
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        [on.declaration.name, 'task_comment'],
        NO_COMMENT_TYPE_FIXES,
      ),
    );
  }
  const comment =
    typeof commentId === 'string'
      ? await lockComment(tx, typeId, on.target.id, commentId)
      : undefined;
  if (comment === undefined) return refused(refuseNotFound());
  const lapsed = await on.stillAuthorised?.();
  if (lapsed !== undefined) return refused(lapsed);
  if (
    comment.authorActorId !== on.actorId ||
    comment.onBehalfOfPersonId !== on.onBehalfOfPersonId
  ) {
    return refused(refuseCommand('SCOPE_NOT_GRANTED', ['commentId'], NOT_AUTHOR_FIXES));
  }
  return { typeId, id: comment.id, editedAt: comment.editedAt?.toISOString() ?? null };
}

const isRefusal = (found: object): found is HandlerOutcome => !('typeId' in found);

/** The instant an edit names, as the read writes it; undefined for none, false for no instant. */
function instantOf(value: unknown): string | null | undefined | false {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return false;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? false : at.toISOString();
}

export async function editTaskComment(
  tx: TenantQuery,
  on: CommentChange,
  commentId: unknown,
  body: unknown,
  expectedEditedAt?: unknown,
): Promise<HandlerOutcome> {
  // The words first, so a bad edit says so without reading the comment.
  if (typeof body !== 'string' || body.trim() === '') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['body'], BODY_FIXES));
  }
  if (!storableText(body)) return refused(refuseUnstorable(['body']));
  const expected = instantOf(expectedEditedAt);
  if (expected === false) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expectedEditedAt'], EDITED_AT_FIXES));
  }
  const found = await ownComment(tx, on, commentId);
  if (isRefusal(found)) return found;
  if (expected !== undefined && expected !== found.editedAt) {
    return refused(refuseCommand('VERSION_STALE', ['expectedEditedAt'], STALE_EDIT_FIXES));
  }
  await rewriteComment(tx, found.typeId, found.id, body);
  return applied(on.target.id, on.target.revision, { commentId: found.id });
}

export async function deleteTaskComment(
  tx: TenantQuery,
  on: CommentChange,
  commentId: unknown,
): Promise<HandlerOutcome> {
  const found = await ownComment(tx, on, commentId);
  if (isRefusal(found)) return found;
  await removeComment(tx, found.typeId, found.id, on.actorId);
  return applied(on.target.id, on.target.revision, { commentId: found.id });
}
