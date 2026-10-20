// SPDX-License-Identifier: AGPL-3.0-only
//
// `review.client_list` (PROTO-GAPS row 7, the director's ruling of register 268): the client
// sees only their own reviews, the client-marked pins and comments, their change requests and
// state, and the decision on the current revision; never internal pins, team comments or
// other clients. The grant is `review:read`, asked at each review's holder inside the query,
// so a party grant lists only that client's reviews. The comments are the task's client
// projection (`commentsFor`, external), the one `task.read` gives a client, so an internal
// pin or a team comment is absent from the rows, not cut from them. A caller holding
// `review:read` nowhere, or an agent's key, is refused `SCOPE_NOT_GRANTED` and learns nothing.
// The grant is judged again after the last read (`stillCovered`), so a review whose grant was
// revoked while its comments were read is left out whole.

import {
  holdsAnywhere,
  readClientReviews,
  stillCovered,
  REVIEW_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { ClientReviewListResult, ClientReviewView } from '../../../core-wire/src/index.ts';
import { refuseCommand } from '../commands/refusal.ts';
import { commentsFor } from './tasks.ts';
import type { ReadRow } from './read-row.ts';

const NO_REVIEW_READ = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

/** A pin on another review of the same task stays with that review. */
const onThisReview = (
  revisionIds: readonly string[],
  comment: Readonly<Record<string, unknown>>,
): boolean => {
  const anchor = comment['anchor'] as { readonly source?: unknown } | undefined;
  return anchor === undefined || revisionIds.includes(String(anchor.source));
};

export const CLIENT_REVIEW_READS: {
  readonly 'review.client_list': ReadRow<'review.client_list'>;
} = {
  'review.client_list': {
    identifiers: [],
    parse: () => ({ ok: true, operands: {} }),
    spine: true,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (
      tx,
      session,
      _operands,
      { spine },
    ): Promise<ClientReviewListResult | ReturnType<typeof refuseCommand>> => {
      const covering = {
        subjects: subjectsOf(session),
        collection: REVIEW_COLLECTION,
        action: 'read',
      };
      if (session.credentialScope !== undefined || !(await holdsAnywhere(tx, covering))) {
        return NO_REVIEW_READ;
      }
      const reviews: ClientReviewView[] = [];
      for (const row of await readClientReviews(tx, covering)) {
        // oxlint-disable-next-line no-await-in-loop -- one transaction's connection, one task at a time
        const projected = await commentsFor(tx, spine.taskCommentTypeId, row.taskId, {
          internal: false,
        });
        const comments = projected.filter((comment) => onThisReview(row.revisionIds, comment));
        const shown = new Set(comments.map((comment) => comment['id']));
        reviews.push({
          reviewId: row.reviewId,
          kind: row.kind,
          pageUrl: row.pageUrl,
          path: row.path,
          revision: row.revision,
          approved: row.approved,
          comments,
          changeRequests: row.changeRequests.filter((request) => shown.has(request.commentId)),
        });
      }
      // The grant again, after the last read: one revoked meanwhile keeps nothing read since.
      const covered = await stillCovered(
        tx,
        covering,
        reviews.map((review) => review.reviewId),
      );
      return { ok: true, reviews: reviews.filter((review) => covered.has(review.reviewId)) };
    },
  },
};
