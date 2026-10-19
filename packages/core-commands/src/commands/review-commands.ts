// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's person commands (#2011): `review.open`, which opens a page review on a
// task or adds its next revision, and `review.capture`, which asks both
// widths' captures of a revision. Each is `review:write` at the review's
// holder: the door asks it there (`prepare.ts`), and the write asks it again
// once its locks are held (`standsAfterWaits`), so a grant revoked while the
// write waited keeps nothing. An agent credential reaches both through this
// path with its person's ticked keys. An agent under a delegation for one task
// writes for its delegating person (`review-agent.ts`), on that person's
// grants, and its delegation is asked again beside them.
//
// Refusals carry fixed text only: no page, path or revision reaches a refused caller.

import {
  askCaptures,
  isUuid,
  openPageReview,
  REVIEW_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type {
  Covering,
  ReviewRefusal,
  ReviewWriter,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };
export type ReviewOpen = Of<'review.open'>;
export type ReviewCapture = Of<'review.capture'>;

const TEXT_LIMIT = 2048;

const REFUSALS: Readonly<Record<ReviewRefusal['code'], CommandRefusal>> = {
  NOT_FOUND: refuseCommand('NOT_FOUND', [], ['Name a task or revision you can see.']),
  PAGE_OUTSIDE_HOLDER_SITE: refuseCommand(
    'PAGE_OUTSIDE_HOLDER_SITE',
    ['pageUrl', 'path'],
    ['Name a page the task’s own site binds, and its file, as the site holds them.'],
  ),
  CAPTURE_ALREADY_ASKED: refuseCommand(
    'CAPTURE_ALREADY_ASKED',
    ['revisionId'],
    ['This revision’s capture is asked already; open a new revision to capture again.'],
  ),
};

/** Who writes, and the `review:write` they stand on at the review's holder. */
export interface ReviewActing {
  readonly covering: Covering;
  readonly writer: ReviewWriter;
}

const personActing = ({ session }: CommandContext): ReviewActing => ({
  covering: { subjects: subjectsOf(session), collection: REVIEW_COLLECTION, action: 'write' },
  writer: { actorId: session.actorId, personId: session.personId, delegationId: null },
});

/** After the last lock wait: the writer's `review:write` at the holder, and its delegation, read again. */
async function endedSince(
  tx: TenantQuery,
  { covering, writer }: ReviewActing,
  partyId: string | null,
): Promise<HandlerOutcome | undefined> {
  const { delegationId } = writer;
  const stood = await standsAfterWaits(tx, {
    covering,
    partyId,
    ...(delegationId === null ? {} : { delegationId }),
  });
  return stood === 'stands' ? undefined : refused(endedRefusal(stood, delegationId !== null));
}

const OPEN_OPERANDS = ['pageUrl', 'path', 'sourceRevision'] as const;

export const openReview = async (
  tx: TenantQuery,
  context: CommandContext,
  request: ReviewOpen,
): Promise<HandlerOutcome> => await openReviewAs(tx, personActing(context), request);

export const askReviewCapture = async (
  tx: TenantQuery,
  context: CommandContext,
  request: ReviewCapture,
): Promise<HandlerOutcome> => await askReviewCaptureAs(tx, personActing(context), request);

export async function openReviewAs(
  tx: TenantQuery,
  acting: ReviewActing,
  request: ReviewOpen,
): Promise<HandlerOutcome> {
  const wrong = [
    ...(isUuid(request.taskId) ? [] : ['taskId']),
    ...OPEN_OPERANDS.filter((name) => {
      const value: unknown = request[name];
      return typeof value !== 'string' || value === '' || value.length > TEXT_LIMIT;
    }),
  ];
  if (wrong.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', wrong, [
        `Send taskId as an identifier, and pageUrl, path and sourceRevision as text of 1 to ${TEXT_LIMIT} characters.`,
      ]),
    );
  }
  const unstorable = unstorableOperands(request, OPEN_OPERANDS);
  if (unstorable.length > 0) return refused(refuseUnstorable(unstorable));
  const opened = await openPageReview(tx, {
    taskId: request.taskId.toLowerCase(),
    pageUrl: request.pageUrl,
    path: request.path,
    sourceRevision: request.sourceRevision,
    writer: acting.writer,
  });
  if ('code' in opened) return refused(REFUSALS[opened.code]);
  const ended = await endedSince(tx, acting, opened.review.partyId);
  if (ended !== undefined) return ended;
  return applied(opened.review.id, null, {
    reviewId: opened.review.id,
    revisionId: opened.revision.id,
    number: opened.revision.number,
    digest: opened.revision.digest,
  });
}

export async function askReviewCaptureAs(
  tx: TenantQuery,
  acting: ReviewActing,
  request: ReviewCapture,
): Promise<HandlerOutcome> {
  // An id left out is the caller's to send; a malformed one names nothing, as a fabricated one.
  if (typeof request.revisionId !== 'string') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['revisionId'], ['Send revisionId as an identifier.']),
    );
  }
  if (!isUuid(request.revisionId)) return refused(REFUSALS.NOT_FOUND);
  const revisionId = request.revisionId.toLowerCase();
  const asked = await askCaptures(tx, revisionId, acting.covering, acting.writer);
  if ('code' in asked) return refused(REFUSALS[asked.code]);
  const ended = await endedSince(tx, acting, asked.review.partyId);
  if (ended !== undefined) return ended;
  return applied(asked.review.id, null, {
    reviewId: asked.review.id,
    revisionId,
    widths: [1480, 390],
  });
}
