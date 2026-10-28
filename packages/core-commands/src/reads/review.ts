// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's reads (#2011), each a row of the read catalogue, kept apart for its line cap.
//
// `review.read`: one review, its revisions in number order and each revision's captures by
// width, with the landed pictures' ids and the observations, and what changed at each width
// since the revision before (`review-difference.ts`). `review.picture`: one landed
// picture's bytes. `review.list`: the business's reviews the caller's grant covers, newest
// change first, for the Reviews page; a reviewer with no team role is refused as one holding
// no grant, so the list never says whether any review exists. The grant is `review:read`,
// asked at the review's holder inside the query, so a party grant reads no other client's
// review. A caller holding `review:read` nowhere is refused `SCOPE_NOT_GRANTED` before any id
// is looked at; for everyone else, not there, in another business, out of reach, a client's
// or malformed is one `NOT_FOUND`. They are the
// team's, as the live correction's reads are, and never an agent's.

import {
  holdsAnywhere,
  isUuid,
  listCoveredReviews,
  readCoveredPicture,
  readCoveredReview,
  REVIEW_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ReviewListResult,
  ReviewPictureResult,
  ReviewReadResult,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { differencesOf } from './review-difference.ts';
import { isInternalReader } from './tasks.ts';
import type { ReadRow } from './read-row.ts';

const NO_REVIEW_READ = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

const reviewRead = (session: Session) =>
  ({ subjects: subjectsOf(session), collection: REVIEW_COLLECTION, action: 'read' }) as const;

const idOperand =
  <F extends string>(field: F, fix: string) =>
  (body: Readonly<Record<string, unknown>>) => {
    const value = body[field];
    return typeof value === 'string'
      ? { ok: true as const, operands: { [field]: value } as Readonly<Record<F, string>> }
      : { ok: false as const, refusal: invalid(field, fix) };
  };

/** The reader's grant somewhere, a team reader and a well-formed id, or the refusal. */
async function admitted(
  tx: TenantQuery,
  session: Session,
  id: string,
): Promise<CommandRefusal | undefined> {
  if (!(await holdsAnywhere(tx, reviewRead(session)))) return NO_REVIEW_READ;
  return isInternalReader(session.roleKey) && isUuid(id) ? undefined : refuseNotFound();
}

export const REVIEW_READS: {
  readonly [K in 'review.read' | 'review.picture' | 'review.list']: ReadRow<K>;
} = {
  'review.read': {
    identifiers: ['reviewId'],
    parse: idOperand('reviewId', 'Send reviewId as the review.'),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) => ('review' in answer ? answer.review.reviewId : undefined),
    serve: async (tx, session, { reviewId }): Promise<ReviewReadResult | CommandRefusal> => {
      const refusal = await admitted(tx, session, reviewId);
      if (refusal !== undefined) return refusal;
      const review = await readCoveredReview(tx, reviewId.toLowerCase(), reviewRead(session));
      return review === undefined
        ? refuseNotFound()
        : { ok: true, review: { ...review, differences: differencesOf(review) } };
    },
  },
  'review.picture': {
    identifiers: ['pictureId'],
    parse: idOperand('pictureId', 'Send pictureId as the landed picture.'),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) => ('picture' in answer ? answer.picture.pictureId : undefined),
    serve: async (tx, session, { pictureId }): Promise<ReviewPictureResult | CommandRefusal> => {
      const refusal = await admitted(tx, session, pictureId);
      if (refusal !== undefined) return refusal;
      const picture = await readCoveredPicture(tx, pictureId.toLowerCase(), reviewRead(session));
      return picture === undefined ? refuseNotFound() : { ok: true, picture };
    },
  },
  'review.list': {
    identifiers: [],
    parse: () => ({ ok: true, operands: {} }),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session): Promise<ReviewListResult | CommandRefusal> => {
      if (!(await holdsAnywhere(tx, reviewRead(session)))) return NO_REVIEW_READ;
      if (!isInternalReader(session.roleKey)) return NO_REVIEW_READ;
      return { ok: true, reviews: await listCoveredReviews(tx, reviewRead(session)) };
    },
  },
};
