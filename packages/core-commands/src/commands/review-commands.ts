// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's person commands (#2011): `review.open`, which opens a page review on a
// task or adds its next revision, and `review.capture`, which asks both
// widths' captures of a revision. Each is `review:write` at the review's
// holder: the door asks it there (`prepare.ts`), and the write asks it again
// once its locks are held (`standsAfterWaits`), so a grant revoked while the
// write waited keeps nothing. An agent credential reaches both through this
// path with its person's ticked keys; a pickup's one-task delegation never
// carries `review` and is refused before it (`review-agent.ts`).
//
// A revision opened on a page after its live correction published may name that correction
// (#2120), so the workspace can show its Receipt: one on the review's own task, page and file
// whose receipts the opener reads (`live_correction.receipts`' own read, `run:write` and
// `task:read`), read again after the last wait with both keys' grants held, so a grant revoked
// or expired while the open waited links nothing. Anything else, a foreign id included, is one
// `NOT_FOUND`, so the open confirms no correction.
//
// Refusals carry fixed text only: no page, path or revision reaches a refused caller.

import {
  askCaptures,
  correctionOnPage,
  holdCoveringGrants,
  isUuid,
  openPageReview,
  readReadableReceipts,
  REVIEW_COLLECTION,
  RUN_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Covering, ReviewRefusal, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';
import { isInternalReader } from '../reads/tasks.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

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

const NO_CORRECTION = refuseCommand(
  'NOT_FOUND',
  ['correctionId'],
  ['Name a correction of this task’s page whose receipts you can read, or none.'],
);

const reviewWrite = (context: CommandContext): Covering => ({
  subjects: subjectsOf(context.session),
  collection: REVIEW_COLLECTION,
  action: 'write',
});

const writerOf = ({ session }: CommandContext) => ({
  actorId: session.actorId,
  personId: session.personId,
  delegationId: null,
});

/** After the last lock wait: the writer's `review:write` at the holder, read again. */
async function endedSince(
  tx: TenantQuery,
  context: CommandContext,
  partyId: string | null,
): Promise<HandlerOutcome | undefined> {
  const stood = await standsAfterWaits(tx, { covering: reviewWrite(context), partyId });
  return stood === 'stands' ? undefined : refused(endedRefusal(stood, false));
}

/** After the last wait: whether the receipts read still reaches `correctionId`, its grants held. */
async function reaches(
  tx: TenantQuery,
  context: CommandContext,
  correctionId: string,
): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  await holdCoveringGrants(tx, { subjects, collection: RUN_COLLECTION, action: 'write' });
  await holdCoveringGrants(tx, { subjects, collection: 'task', action: 'read' });
  return (await readReadableReceipts(tx, correctionId, subjects)) !== undefined;
}

/** The correction a revision names, lowercase: null for none, undefined when it may not. */
async function namedCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.open'>,
): Promise<string | null | undefined> {
  const sent = request.correctionId;
  if (sent === undefined) return null;
  if (typeof sent !== 'string' || !isUuid(sent)) return undefined;
  // The receipts read is a person's on the team, never an agent credential's.
  const { session } = context;
  if (session.credentialScope !== undefined || !isInternalReader(session.roleKey)) return undefined;
  const correctionId = sent.toLowerCase();
  const page = {
    taskId: request.taskId.toLowerCase(),
    pageUrl: request.pageUrl,
    path: request.path,
  };
  if (!(await correctionOnPage(tx, correctionId, page))) return undefined;
  // Read only: the grants are held after the record locks, in the order every write takes.
  const reached = await readReadableReceipts(tx, correctionId, subjectsOf(session));
  return reached === undefined ? undefined : correctionId;
}

const OPEN_OPERANDS = ['pageUrl', 'path', 'sourceRevision'] as const;

export async function openReview(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.open'>,
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
  const correctionId = await namedCorrection(tx, context, request);
  if (correctionId === undefined) return refused(NO_CORRECTION);
  const opened = await openPageReview(tx, {
    taskId: request.taskId.toLowerCase(),
    pageUrl: request.pageUrl,
    path: request.path,
    sourceRevision: request.sourceRevision,
    writer: writerOf(context),
    correctionId,
  });
  if ('code' in opened) return refused(REFUSALS[opened.code]);
  const ended = await endedSince(tx, context, opened.review.partyId);
  if (ended !== undefined) return ended;
  // After the last wait: the correction is still one the receipts read reaches.
  if (correctionId !== null && !(await reaches(tx, context, correctionId))) {
    return refused(NO_CORRECTION);
  }
  return applied(opened.review.id, null, {
    reviewId: opened.review.id,
    revisionId: opened.revision.id,
    number: opened.revision.number,
    digest: opened.revision.digest,
  });
}

export async function askReviewCapture(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.capture'>,
): Promise<HandlerOutcome> {
  // An id left out is the caller's to send; a malformed one names nothing, as a fabricated one.
  if (typeof request.revisionId !== 'string') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['revisionId'], ['Send revisionId as an identifier.']),
    );
  }
  if (!isUuid(request.revisionId)) return refused(REFUSALS.NOT_FOUND);
  const revisionId = request.revisionId.toLowerCase();
  const asked = await askCaptures(tx, revisionId, reviewWrite(context), writerOf(context));
  if ('code' in asked) return refused(REFUSALS[asked.code]);
  const ended = await endedSince(tx, context, asked.review.partyId);
  if (ended !== undefined) return ended;
  return applied(asked.review.id, null, {
    reviewId: asked.review.id,
    revisionId,
    widths: [1480, 390],
  });
}
