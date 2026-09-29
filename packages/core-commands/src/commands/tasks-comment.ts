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
// **The one local effect (T2c2).** A worker's effect is a team-only comment
// written here under the operation identity derived from its attempt
// (`effectOperationId`), so a retry replays it and the register answers
// whether it happened. That identity is accepted only once the attempt's step
// is marked dispatched to this caller's own lease: no effect before its
// dispatch, whichever entry sends it.
// **A reply (R42).** `parentId` names a top-level message on the same task,
// read under its lock through the task: a reply to a reply, a message on
// another task or in another business, or one already deleted is refused
// naming `parentId`. A reply goes to its message's audience, so a client is
// only ever shown the id of a client message. A reply to a client message
// from the other side answers it (`comment answered`): the signal is derived
// at read (`commentSignals`), and the reply's audit event is the record of it.

import {
  audienceNotPermitted,
  lockComment,
  writeComment,
} from '../../../core-records/src/index.ts';
import { acquire } from '../../../core-runtime/src/index.ts';
import type {
  TenantQuery,
  CommentAudience,
  CommentType,
  EntryPoint,
} from '../../../core-records/src/index.ts';
import type { CommandContext, TaskRow } from './context.ts';
import { effectAttemptOf, type CommandDeclaration } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
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
  operationId: string,
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
      operationId,
      delegationId: null,
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
  commentTypeId: string,
  taskId: string,
  parentId: unknown,
  audience: string,
): Promise<string | null | HandlerOutcome> {
  if (parentId === undefined || parentId === null) return null;
  const message =
    typeof parentId === 'string'
      ? await lockComment(tx, commentTypeId, taskId, parentId)
      : undefined;
  if (message === undefined || message.parentId !== null) {
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
  /** The request's identity: an effect's names the attempt it applies (T2c2). */
  readonly operationId: string;
  /** The delegation the author acts under, or `null` for a person. */
  readonly delegationId: string | null;
}

const EFFECT_FIXES: readonly string[] = [
  'Dispatch the step under your own lease first; its answer names the attempt.',
  'Nothing was written.',
];

/**
 * The refusal an effect identity earns, or `undefined`: the one effect is a
 * team-only comment, on an attempt marked dispatched to the author's own lease
 * on this task. Any other identity is an ordinary comment and passes.
 *
 * T2d: the attempt must still be `dispatched`. Once observe has settled it, or
 * held it as an unknown liability, its outcome is recorded and a late effect
 * would contradict it. A retried effect is
 * unaffected: the register replays it before this runs.
 *
 * The step is found only through an attempt whose lease binds it to this task
 * and this author, so another client's attempt is refused before anything of
 * its is locked or waited on. That step is
 * then locked through the one lock helper and held to commit, and the check
 * runs again under it: observe takes the same lock, so it cannot settle the
 * attempt between this check and the comment's write.
 */
async function effectRefusal(
  tx: TenantQuery,
  on: CommentTarget,
  audience: string,
): Promise<CommandRefusal | undefined> {
  const attemptId = effectAttemptOf(on.operationId);
  if (attemptId === undefined) return undefined;
  if (audience !== 'internal') {
    return audienceNotPermitted('The effect is a team-only comment. Send audience as internal.');
  }
  const found = await dispatchedToAuthor(tx, on, attemptId);
  if (found === undefined) return refuseCommand('EFFECT_NOT_DISPATCHED', [], EFFECT_FIXES);
  await acquire(tx, [{ lockClass: 'step', id: found.step_id }]);
  const held = await dispatchedToAuthor(tx, on, attemptId);
  return held === undefined ? refuseCommand('EFFECT_NOT_DISPATCHED', [], EFFECT_FIXES) : undefined;
}

/** The attempt's step, when the attempt is dispatched to the author's own lease on this task. */
async function dispatchedToAuthor(
  tx: TenantQuery,
  on: CommentTarget,
  attemptId: string,
): Promise<{ readonly step_id: string } | undefined> {
  const rows = await tx.query<{ readonly step_id: string }>(
    `select att.step_id from public.attempts att
       join public.leases l on l.business_id = att.business_id and l.id = att.lease_id
      where att.business_id = $1 and att.id = $2 and att.dispatch_marker
        and att.state = 'dispatched' and l.task_id = $3
        and l.holder_actor_id = $4 and l.delegation_id is not distinct from $5::uuid`,
    [tx.businessId, attemptId, on.target.id, on.authorActorId, on.delegationId],
  );
  return rows[0];
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
      audienceNotPermitted(
        `This caller writes in ${[...on.audiences].toSorted().join(' or ')} only.`,
      ),
    );
  }
  if (commentType !== undefined && (typeof commentType !== 'string' || !TYPES.has(commentType))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['comment_type'], TYPE_FIXES));
  }

  const effect = await effectRefusal(tx, on, audience);
  if (effect !== undefined) return refused(effect);
  const parent = await replyParent(tx, commentTypeId, on.target.id, parentId, audience);
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
