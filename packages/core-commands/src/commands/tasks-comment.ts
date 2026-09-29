// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.comment`: one comment on one task, written through the comment record
// type the task installer adds.
//
// The envelope has already required the identity, checked the `comment`
// grant, locked the task and written the audit event, and none of that is
// repeated here.
//
// **A business with no comment type.** One seeded before the comment record
// type was installed has a task spine and no `task_comment` type. A comment
// there is refused `DEPENDENCY_NOT_LANDED`, naming the command and the record
// type: a missing record type is not a fault in the caller's request.
//
// **What this handler decides, and what it does not.** It decides that the
// audience and the kind are values the model has, because a comment addressed
// to an audience nobody defined is a comment whose readers are undecided. It
// does not widen *who may write in an audience*: a member holding `comment`
// writes in either, as before. An external party (R4, no membership) writes
// in `client` alone whatever grant rows it holds, so no provisioned `comment`
// grant carries an outsider to a team note. A delegated agent is narrower. It reaches this
// through `writeTaskComment` with `internal` alone, so a client-visible comment
// stays a person's act and the agent is told `AUDIENCE_NOT_PERMITTED`
// (`agent-envelope.ts`). Whether writing to the client should be the `share`
// action rather than `comment` for a person is still a grant-model decision.
//
// The author is the acting actor and the posting time is the server's. Neither
// is a payload field: a comment whose author or time a caller can choose is
// not evidence of anything, which is why both are `system` on the spine.
//
// **A reply (R42).** `parentId` names a top-level message on the same task,
// read under its lock through the task: a reply to a reply, a message on
// another task or in another business, or one already deleted is refused
// naming `parentId`. A reply goes to its message's audience, so a client is
// only ever shown the id of a client message. A reply to a client message
// from the other side answers it (`comment answered`): the signal is derived
// at read (`commentSignals`), and the reply's audit event is the record of it.

import { lockComment, writeComment } from '../../../core-records/src/index.ts';
import type {
  TenantQuery,
  CommentAudience,
  CommentType,
  EntryPoint,
} from '../../../core-records/src/index.ts';
import type { CommandContext, TaskRow } from './context.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseUnstorable, storableText } from './values.ts';

const AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['internal', 'client']);
const EXTERNAL_AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['client']);
const TYPES: ReadonlySet<string> = new Set<CommentType>(['note', 'client', 'system']);

/** What a person writing on a task writes, when they say nothing else. */
const DEFAULT_TYPE: CommentType = 'note';

const AUDIENCE_FIXES: readonly string[] = [
  'Send audience as internal or client.',
  'The audience is who may read it; comment_type is what it is. They are two fields.',
];

const TYPE_FIXES: readonly string[] = [
  'Send comment_type as note, client or system, or leave it out for a note.',
];

const BODY_FIXES: readonly string[] = ['Send a body with something in it.'];

const PARENT_FIXES: readonly string[] = [
  'Send parentId as the id of a message on this task, or leave it out for a new message.',
  'Replies are one level deep: reply to the message, not to a reply.',
];

const REPLY_AUDIENCE_FIXES: readonly string[] = [
  'A reply goes to the audience of the message it answers.',
];

export const NO_COMMENT_TYPE_FIXES: readonly string[] = [
  'This business has no comment record type installed, so it cannot hold a comment.',
  'It is not a permission problem and retrying will not change it.',
];

export async function commentOnTask(
  tx: TenantQuery,
  context: CommandContext,
  body: unknown,
  audience: unknown,
  commentType: unknown,
  parentId: unknown,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) {
    throw new Error('commentOnTask: reached without the task the declaration targets');
  }
  return await writeTaskComment(
    tx,
    {
      commentTypeId: context.spine.taskCommentTypeId,
      declaration: context.declaration,
      target,
      authorActorId: context.session.actorId,
      entryPoint: context.entryPoint,
      audiences: context.session.roleKey === null ? EXTERNAL_AUDIENCES : AUDIENCES,
    },
    body,
    audience,
    commentType,
    parentId,
  );
}

/**
 * The message a reply sits under, locked through its task: its id, null for a
 * new message, or the refusal. One level deep, and in the message's audience.
 */
async function replyParent(
  tx: TenantQuery,
  on: CommentTarget,
  commentTypeId: string,
  parentId: unknown,
  audience: string,
): Promise<string | null | HandlerOutcome> {
  if (parentId === undefined || parentId === null) return null;
  const message =
    typeof parentId === 'string'
      ? await lockComment(tx, commentTypeId, on.target.id, parentId)
      : undefined;
  // A message in an audience this caller may not write in (an internal note,
  // to a client's person or an agent) is answered as one that is not there,
  // so a reply cannot be used to learn that a note it cannot see exists.
  if (message === undefined || message.parentId !== null || !on.audiences.has(message.audience)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['parentId'], PARENT_FIXES));
  }
  if (message.audience !== audience) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['audience'], REPLY_AUDIENCE_FIXES));
  }
  return message.id;
}

/** What a comment is written against, from whichever envelope reached it. */
export interface CommentTarget {
  readonly commentTypeId: string | undefined;
  readonly declaration: CommandDeclaration;
  /** The task, as its envelope locked it: `deleted_at` is read with the row. */
  readonly target: TaskRow;
  readonly authorActorId: string;
  readonly entryPoint: EntryPoint;
  /**
   * The audiences this caller may write in. A member holding `comment` writes
   * in either; an external party (`EXTERNAL_AUDIENCES`) and a delegated agent
   * (`AGENT_AUDIENCES`, `agent-operations.ts`) are narrower, and an audience
   * outside this set is `AUDIENCE_NOT_PERMITTED` rather than the shape
   * refusal an unknown audience gets.
   */
  readonly audiences: ReadonlySet<string>;
}

/**
 * The comment itself, shared by the person path above and the agent path. It
 * validates the body, the audience and the type, and commits the comment with
 * its own identity, which is the answer's `commentId`.
 *
 * A trashed task is answered as a missing one, `NOT_FOUND` in the same bytes,
 * on both entries (Nathan's ruling, OWNER-CARD section 6). Both reach here
 * through `lockTask`, which holds a trashed row as well as a live one because
 * trash and restore need it, so the check is here rather than in the lock.
 * The row is already held, so it cannot be trashed between this and the write.
 */
export async function writeTaskComment(
  tx: TenantQuery,
  on: CommentTarget,
  body: unknown,
  audience: unknown,
  commentType: unknown,
  parentId: unknown = undefined,
): Promise<HandlerOutcome> {
  if (on.target.deleted_at !== null) return refused(refuseNotFound());
  const commentTypeId = on.commentTypeId;
  if (commentTypeId === undefined) {
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        [on.declaration.name, 'task_comment'],
        NO_COMMENT_TYPE_FIXES,
      ),
    );
  }

  if (typeof body !== 'string' || body.trim() === '') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['body'], BODY_FIXES));
  }
  // The person path refuses this at the door (`prepare.ts`); the agent entry
  // does not pass that door, and reaches here. Past this line, Postgres would
  // raise on a NUL and the driver would write an unpaired surrogate as U+FFFD.
  if (!storableText(body)) return refused(refuseUnstorable(['body']));
  if (typeof audience !== 'string' || !AUDIENCES.has(audience)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['audience'], AUDIENCE_FIXES));
  }
  if (!on.audiences.has(audience)) {
    return refused(
      refuseCommand(
        'AUDIENCE_NOT_PERMITTED',
        ['audience'],
        [`This caller writes in ${[...on.audiences].toSorted().join(' or ')} only.`],
      ),
    );
  }
  if (commentType !== undefined && (typeof commentType !== 'string' || !TYPES.has(commentType))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['comment_type'], TYPE_FIXES));
  }

  const parent = await replyParent(tx, on, commentTypeId, parentId, audience);
  if (typeof parent === 'object' && parent !== null) return parent;

  const commentId = await writeComment(tx, commentTypeId, {
    taskId: on.target.id,
    authorActorId: on.authorActorId,
    commentType: (commentType as CommentType | undefined) ?? DEFAULT_TYPE,
    audience: audience as CommentAudience,
    body,
    source: on.entryPoint,
    parentId: parent,
  });

  return applied(on.target.id, on.target.revision, { commentId });
}
