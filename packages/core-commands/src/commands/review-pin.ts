// SPDX-License-Identifier: AGPL-3.0-only
//
// `review.pin_comment` (C35, #2012): a comment on the review's task, pinned to a spot on one
// width's capture of a revision. It is `review:comment` at the review's holder: the door asks
// it there (`prepare.ts`), the review is locked and judged again in the statement, and the
// key is read once more after the last lock wait, an agent's after its identity waits too
// (`agent-standing.ts`), so a grant revoked or run out while the pin waited keeps nothing. An
// agent pins inside a delegation for the review's own task only, and only a team note
// (`AGENT_AUDIENCES`), as its other comments are.
//
// The comment itself is `task.comment`'s (`writeTaskComment`): body, audience and storability
// are judged there. The task is locked before the review, the order `review.open` takes.
//
// A pin made on the live view (#2120) names `liveViewport`, the frame's width, and is kept on
// the capture only where the live view corresponds to it: at the capture's own width, on the
// review's newest revision with that width's capture landed, read after the review's lock, and
// with no text quoted, since a quote would be the live page's word, not the capture's. A nonce
// proves only which frame said hello, never that the page is the one captured. Anything else
// asks a fresh capture.

import {
  capturedNewest,
  delegatingSubjects,
  lockPinnedReview,
  REVIEW_COLLECTION,
  subjectsOf,
  taskOfRevision,
} from '../../../core-records/src/index.ts';
import type {
  Anchor,
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
import {
  isRefused,
  refused,
  type HandlerOutcome,
  type JudgedLast,
  type Refused,
} from './outcome.ts';
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
const NOT_AT_WIDTH = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['liveViewport'],
  ['Pin on the live view only at the capture’s own width, or pin on the capture itself.'],
);
const LIVE_QUOTE = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['selector'],
  ['A pin on the live view marks a spot only; quote text on the capture itself.'],
);
const FRESH_CAPTURE = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['revisionId'],
  ['The live view no longer matches this capture: ask a fresh capture and pin again on it.'],
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
function anchorOf(sent: Sent): Extract<AnchorParse, { ok: true }>['anchor'] | Refused {
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

/** A live-view pin's own refusal before any record is read: its width and its selectors. */
function liveRefusal(sent: Sent, anchor: Anchor): Refused | undefined {
  const viewport = sent['liveViewport'];
  if (viewport === undefined) return undefined;
  if (viewport !== anchor.width) return refused(NOT_AT_WIDTH);
  const marksOnly = anchor.selector.every((selector) => selector.type === 'FragmentSelector');
  return marksOnly ? undefined : refused(LIVE_QUOTE);
}

async function pin(tx: TenantQuery, by: Pinner, sent: Sent): Promise<JudgedLast> {
  const anchor = anchorOf(sent);
  if (!('source' in anchor)) return anchor;
  const live = liveRefusal(sent, anchor);
  if (live !== undefined) return live;
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
  const stale = 'liveViewport' in sent && !(await capturedNewest(tx, anchor.source, anchor.width));
  if (stale) return refused(FRESH_CAPTURE);
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
  if (isRefused(written)) return written;
  const standing = {
    covering,
    partyId: locked.review.partyId,
    ...(by.delegation === undefined ? {} : { delegationId: by.delegation.id }),
  };
  const ended = async () => {
    const stood = await standsAfterWaits(tx, standing);
    return stood === 'stands' ? undefined : endedRefusal(stood, by.delegation !== undefined);
  };
  const first = await ended();
  // The agent path waits on its actor, login and audit chain after this returns (its last
  // waits, `agent-standing.ts`), so the key and the delegation are read once more after them.
  return first === undefined ? { ...written, lastCheck: ended } : refused(first);
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
): Promise<JudgedLast> {
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
  ) => Promise<JudgedLast>;
} = {
  authority: 'record',
  subjectTask: 'record',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, call, _operands, delegation) =>
    await pinCommentAsAgent(tx, call, call.request, delegation),
};
