// SPDX-License-Identifier: AGPL-3.0-only
//
// `review.pin_comment` (C35, #2012): a comment on the review's task, pinned to a spot on one
// width's capture of a revision. It is `review:comment` at the review's holder: the door asks
// it there (`prepare.ts`), the review is locked and judged again in the statement, and the
// key is read once more after the last lock wait, so a grant revoked while the pin waited
// keeps nothing. An agent pins inside a delegation for the review's own task only, and only a
// team note (`AGENT_AUDIENCES`), as its other comments are.
//
// The comment itself is `task.comment`'s (`writeTaskComment`): body, audience and storability
// are judged there. The task is locked before the review, the order `review.open` takes.

import {
  delegatingSubjects,
  lockPinnedReview,
  REVIEW_COLLECTION,
  subjectsOf,
  taskOfRevision,
} from '../../../core-records/src/index.ts';
import type {
  Covering,
  Delegation,
  EntryPoint,
  Subject,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import type { CommandContext } from './context.ts';
import { readTaskSpine } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { lockTask } from './prepare.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import {
  AGENT_AUDIENCES,
  audiencesOf,
  representedPerson,
  writeTaskComment,
} from './tasks-comment.ts';
import { parseAnchor, type AnchorParse } from './review-anchor.ts';

type PinRequest = CommandRequest & { readonly command: 'review.pin_comment' };
type Sent = Readonly<Record<string, unknown>>;

const FIXES: Readonly<Record<string, string>> = {
  width: 'Send width as 1480 or 390, a width this revision was captured at.',
  selector:
    'Send selector as a list: one FragmentSelector conforming to http://www.w3.org/TR/media-frags/ with xywh inside the capture, and at most one TextQuoteSelector.',
};

const NO_CAPTURE = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['width'],
  ['This revision has no capture asked at that width; ask its capture first.'],
);
const OUT_OF_PURPOSE = refuseCommand(
  'DELEGATION_OUT_OF_PURPOSE',
  ['revisionId'],
  ['A delegation reaches only the task it was minted for.'],
);

/** Who pins, and under which authority, from either entry. */
interface Pinner {
  readonly subjects: readonly Subject[];
  readonly actorId: string;
  readonly entryPoint: EntryPoint;
  readonly declaration: CommandDeclaration;
  readonly operationId: string;
  readonly audiences: ReadonlySet<string>;
  readonly onBehalfOfPersonId: string | null;
  /** An agent's delegation: its task bounds the pin, and it must still stand after the waits. */
  readonly delegation?: Delegation;
}

/**
 * The anchor, or its refusal: a revision id left out is the caller's to send, and a malformed
 * one names no revision, as a foreign one.
 */
function anchorOf(sent: Sent): Extract<AnchorParse, { ok: true }>['anchor'] | HandlerOutcome {
  if (typeof sent['revisionId'] !== 'string') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['revisionId'], ['Send revisionId as an identifier.']),
    );
  }
  const parsed = parseAnchor(sent);
  if (parsed.ok) return parsed.anchor;
  const [name = 'selector'] = parsed.names;
  if (name === 'revisionId') return refused(refuseNotFound());
  return refused(
    refuseCommand('FIELD_VALUE_INVALID', [name], [FIXES[name] ?? FIXES['selector'] ?? '']),
  );
}

async function pin(tx: TenantQuery, by: Pinner, sent: Sent): Promise<HandlerOutcome> {
  const anchor = anchorOf(sent);
  if (!('source' in anchor)) return anchor;
  const named = await taskOfRevision(tx, anchor.source);
  if (named === undefined) return refused(refuseNotFound());
  if (by.delegation !== undefined && by.delegation.purposeScope.id !== named.taskId) {
    return refused(OUT_OF_PURPOSE);
  }
  const spine = await readTaskSpine(tx);
  const task = await lockTask(tx, spine.taskTypeId, named.taskId);
  if (task === undefined) return refused(refuseNotFound());
  const covering: Covering = {
    subjects: by.subjects,
    collection: REVIEW_COLLECTION,
    action: 'comment',
  };
  const locked = await lockPinnedReview(tx, named.reviewId, anchor.source, covering);
  if (locked === undefined) return refused(refuseNotFound());
  if (!locked.widths.includes(anchor.width)) return refused(NO_CAPTURE);
  const written = await writeTaskComment(
    tx,
    {
      commentTypeId: spine.taskCommentTypeId,
      declaration: by.declaration,
      target: task,
      authorActorId: by.actorId,
      entryPoint: by.entryPoint,
      audiences: by.audiences,
      operationId: by.operationId,
      delegationId: by.delegation?.id ?? null,
      onBehalfOfPersonId: by.onBehalfOfPersonId,
      anchor,
    },
    sent['body'],
    sent['audience'],
    sent['audience'] === 'client' ? 'client' : undefined,
  );
  if ('refusal' in written) return written;
  const stood = await standsAfterWaits(tx, {
    covering,
    partyId: locked.review.partyId,
    ...(by.delegation === undefined ? {} : { delegationId: by.delegation.id }),
  });
  return stood === 'stands' ? written : refused(endedRefusal(stood, by.delegation !== undefined));
}

/** A person's pin in the audiences `task.comment` lets them write; an agent credential's is a team note. */
export async function pinComment(
  tx: TenantQuery,
  context: CommandContext,
  request: PinRequest,
): Promise<HandlerOutcome> {
  const { session } = context;
  return await pin(
    tx,
    {
      subjects: subjectsOf(session),
      actorId: session.actorId,
      entryPoint: context.entryPoint,
      declaration: context.declaration,
      operationId: request.operationId,
      audiences: audiencesOf(session),
      onBehalfOfPersonId: representedPerson(session),
    },
    request,
  );
}

/** An agent's pin inside `delegation`, for the delegating person and on its task alone. */
export async function pinCommentAsAgent(
  tx: TenantQuery,
  call: {
    readonly session: { readonly actorId: string };
    readonly declaration: CommandDeclaration;
  },
  sent: Sent,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  return await pin(
    tx,
    {
      subjects: await delegatingSubjects(tx, delegation),
      actorId: call.session.actorId,
      entryPoint: 'api',
      declaration: call.declaration,
      operationId: String(sent['operationId']),
      audiences: AGENT_AUDIENCES,
      onBehalfOfPersonId: delegation.delegatePersonId,
      delegation,
    },
    sent,
  );
}

/**
 * `review.pin_comment`'s agent row: `review:comment` on the task the call is about, the
 * delegation's own when the body names none, and served on that task alone. A replay is
 * asked again, as a comment's is.
 */
export const PIN_COMMENT: {
  readonly authority: 'record';
  readonly subjectTask: 'record';
  readonly replay: 'reauthorise';
  readonly operands: () => Readonly<Record<string, never>>;
  readonly serve: (
    tx: TenantQuery,
    call: {
      readonly session: { readonly actorId: string };
      readonly declaration: CommandDeclaration;
      readonly request: Sent;
    },
    operands: Readonly<Record<string, never>>,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
} = {
  authority: 'record',
  subjectTask: 'record',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, call, _operands, delegation) =>
    await pinCommentAsAgent(tx, call, call.request, delegation),
};
