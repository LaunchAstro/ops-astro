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
// dispatch, whichever entry sends it (`tasks-comment-effect.ts`).
// **A reply (R42).** `parentId` names a top-level message on the same task,
// read under its lock through the task: a reply to a reply, a message on
// another task or in another business, or one already deleted is refused
// naming `parentId`. A reply goes to its message's audience, so a client is
// only ever shown the id of a client message. A reply to a client message
// from the other side answers it (`comment answered`): the signal is derived
// at read (`commentSignals`), and the reply's audit event is the record of it.

import {
  audienceNotPermitted,
  raiseMentions,
  readMentions,
  seenBy,
  type Mentioned,
  writeComment,
} from '../../../core-records/src/index.ts';
import type {
  TenantQuery,
  CommentAudience,
  CommentType,
  EntryPoint,
} from '../../../core-records/src/index.ts';
import type { CommandContext, TaskRow } from './context.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { refuseUnstorable, storableText } from './values.ts';
import { replyParent } from './tasks-comment-reply.ts';
import { effectRefusal } from './tasks-comment-effect.ts';

const AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['internal', 'client']);
const EXTERNAL_AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['client']);
/** What an agent writes a comment in, delegated or by credential: its team's notes, not the client's thread. */
export const AGENT_AUDIENCES: ReadonlySet<string> = new Set<CommentAudience>(['internal']);
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

export const NO_COMMENT_TYPE_FIXES: readonly string[] = [
  'This business has no comment record type installed, so it cannot hold a comment.',
  'It is not a permission problem and retrying will not change it.',
];

const MENTIONS_FIXES: readonly string[] = [
  'Send mentions as a list of person ids, or leave it out.',
];

/**
 * The person a person-entry caller's comment is written for: none for a
 * person writing their own, and for an agent credential (API-2), whose actor
 * is the agent, the person it acts for (`session.personId`), as a delegation
 * records its own (OW-036.1).
 */
export function representedPerson(session: CommandContext['session']): string | null {
  return session.credentialScope === undefined ? null : session.personId;
}

/**
 * Who a person-entry caller writes for: an agent credential (API-2) is its
 * agent and writes team notes only, as the agent row does (#420); an external
 * party writes to the client; a member writes either.
 */
function audiencesOf(session: CommandContext['session']): ReadonlySet<string> {
  if (session.credentialScope === undefined) {
    return session.roleKey === null ? EXTERNAL_AUDIENCES : AUDIENCES;
  }
  return AGENT_AUDIENCES;
}

export async function commentOnTask(
  tx: TenantQuery,
  context: CommandContext,
  operationId: string,
  body: unknown,
  audience: unknown,
  commentType: unknown,
  parentId: unknown,
  mentions: unknown,
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
      audiences: audiencesOf(context.session),
      operationId,
      delegationId: null,
      onBehalfOfPersonId: representedPerson(context.session),
    },
    body,
    audience,
    commentType,
    parentId,
    mentions,
  );
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
   * in either; an external party (`EXTERNAL_AUDIENCES`) and an agent, delegated
   * or by credential (`AGENT_AUDIENCES`), are narrower, and an audience
   * outside this set is `AUDIENCE_NOT_PERMITTED` rather than the shape
   * refusal an unknown audience gets.
   */
  readonly audiences: ReadonlySet<string>;
  /** The request's identity: an effect's names the attempt it applies (T2c2). */
  readonly operationId: string;
  /** The delegation the author acts under, or `null` for a person. */
  readonly delegationId: string | null;
  /** The person an agent acts for (its delegation's, or its credential's), stored on the comment; `null` for a person. */
  readonly onBehalfOfPersonId: string | null;
}

/**
 * The refusal of mentions that cannot read the comment. It names each person
 * only to an author who could already see them (`seenBy`), and otherwise gives
 * back the identifier exactly as sent: its stored letter case would say it exists.
 * The register keeps the identifiers-only form, so a replay names nobody the
 * author may no longer see.
 */
async function unreadableMentions(
  tx: TenantQuery,
  on: CommentTarget,
  named: readonly string[],
  unreadable: readonly Mentioned[],
): Promise<Refused> {
  const ids = unreadable.map((person) => person.personId);
  const seen = await seenBy(tx, on.authorActorId, ids);
  const sent = new Map(named.map((id) => [id.toLowerCase(), id] as const));
  const asSent = (person: Mentioned): string =>
    sent.get(person.personId.toLowerCase()) ?? person.personId;
  const refusal = (shown: (person: Mentioned) => string): CommandRefusal =>
    refuseCommand(
      'MENTION_NOT_READABLE',
      ['mentions'],
      unreadable.map((person) => `${shown(person)} cannot read this comment: remove the mention.`),
    );
  return {
    refusal: refusal((person) => (seen.has(person.personId) ? person.label : asSent(person))),
    kept: refusal(asSent),
  };
}

/**
 * A comment's body, or its refusal: words in it, and storable. Shared by every
 * comment writer, a team conversation's message (C71) among them.
 */
export function commentBodyOf(body: unknown): string | HandlerOutcome {
  if (typeof body !== 'string' || body.trim() === '') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['body'], BODY_FIXES));
  }
  // The person path refuses this at the door (`prepare.ts`); the agent entry
  // does not pass that door, and reaches here. Past this line, Postgres would
  // raise on a NUL and the driver would write an unpaired surrogate as U+FFFD.
  return storableText(body) ? body : refused(refuseUnstorable(['body']));
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
  mentions?: unknown,
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

  const words = commentBodyOf(body);
  if (typeof words !== 'string') return words;
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
  const named = mentions ?? [];
  if (!Array.isArray(named) || !named.every((id): id is string => isIdentifier(id))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['mentions'], MENTIONS_FIXES));
  }
  // INB-1: a mention of someone who cannot read the comment is refused before
  // it saves, rather than raising an item they could never open.
  const task = { taskId: on.target.id, audience };
  const mentioned = await readMentions(tx, task, named);
  const unreadable = mentioned.filter((person) => !person.readable);
  if (unreadable.length > 0) {
    return await unreadableMentions(tx, on, named, unreadable);
  }

  const effect = await effectRefusal(tx, on, audience);
  if (effect !== undefined) return refused(effect);
  const parent = await replyParent(tx, { ...on, commentTypeId }, parentId, audience);
  if (typeof parent === 'object' && parent !== null) return parent;

  const commentId = await writeComment(tx, commentTypeId, {
    taskId: on.target.id,
    authorActorId: on.authorActorId,
    commentType: (commentType as CommentType | undefined) ?? DEFAULT_TYPE,
    audience: audience as CommentAudience,
    body: words,
    source: on.entryPoint,
    parentId: parent,
    onBehalfOfPersonId: on.onBehalfOfPersonId,
  });
  await raiseMentions(tx, { ...task, commentId, authorActorId: on.authorActorId }, mentioned);

  return applied(on.target.id, on.target.revision, { commentId });
}
