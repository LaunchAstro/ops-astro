// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.comment`: one comment on one task, written through the comment record
// type L2 installs.
//
// It was one of the five `refuseUnlanded` routes, waiting on "a comment record
// type, which no part of the split owns". L2 owns it now (`tasks/comments.ts`),
// so this is the whole of what was missing: the envelope already required the
// identity, checked the `comment` grant, locked the task and wrote the audit
// event, and none of that is repeated here.
//
// **What this handler decides, and what it does not.** It decides that the
// audience and the kind are values the model has, because a comment addressed
// to an audience nobody defined is a comment whose readers are undecided. It
// does not decide *who may write in an audience*: `AUDIENCE_NOT_PERMITTED` is
// registered for that and stays unproduced, because the authority question —
// whether writing to the client is the `share` action rather than `comment` —
// is a grant-model decision and the grant model is not this lane's to make.
//
// The author is the acting actor and the posting time is the server's. Neither
// is a payload field: a comment whose author or time a caller can choose is
// not evidence of anything, which is why both are `system` on the spine.

import type { TenantQuery } from '../tenancy/database.ts';
import { writeComment, type CommentAudience, type CommentType } from '../tasks/comments.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseUnlanded } from './pending.ts';

const AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['internal', 'client']);
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

export async function commentOnTask(
  tx: TenantQuery,
  context: CommandContext,
  body: unknown,
  audience: unknown,
  commentType: unknown,
): Promise<HandlerOutcome> {
  const commentTypeId = context.spine.taskCommentTypeId;
  // A business with no comment type installed is the state the declaration's
  // `waitingOn` used to describe for everybody. It is now a property of one
  // installation rather than of the build, and it is still the honest answer.
  if (commentTypeId === undefined) return refuseUnlanded(context.declaration);

  if (typeof body !== 'string' || body.trim() === '') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['body'], BODY_FIXES));
  }
  if (typeof audience !== 'string' || !AUDIENCES.has(audience)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['audience'], AUDIENCE_FIXES));
  }
  if (commentType !== undefined && (typeof commentType !== 'string' || !TYPES.has(commentType))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['comment_type'], TYPE_FIXES));
  }

  const target = context.target;
  if (target === undefined) {
    throw new Error('commentOnTask: reached without the task the declaration targets');
  }

  const commentId = await writeComment(tx, commentTypeId, {
    taskId: target.id,
    authorActorId: context.session.actorId,
    commentType: (commentType as CommentType | undefined) ?? DEFAULT_TYPE,
    audience: audience as CommentAudience,
    body,
    source: context.entryPoint,
  });

  // The task's own revision is unchanged: a comment is a record beside the
  // task and not an edit to it, so the caller may keep writing against the
  // revision they already hold. The comment's identifier is the detail,
  // because it is the thing the caller now has and can refer to.
  return applied(target.id, target.revision, { commentId });
}
