// SPDX-License-Identifier: AGPL-3.0-only
//
// What `review.client_list` answers (PROTO-GAPS row 7): the reviews a client's grant covers,
// each with its current revision's number and approval, the task's client comments on it
// (pins and plain comments, in the fields the catalogue marks `shared`) and its change
// requests by state. Never an internal pin, a team comment, a request's text or a decider.

import type { ChangeRequestState } from '../../core-records/src/index.ts';

export interface ClientReviewView {
  readonly reviewId: string;
  readonly kind: 'page' | 'media';
  readonly pageUrl: string | null;
  readonly path: string | null;
  /** The current revision's number; null for a review with none. */
  readonly revision: number | null;
  /** The current revision's approval, or null while it is undecided. */
  readonly approved: { readonly decidedAt: string } | null;
  /** The task's client projection: a pin carries its `anchor` on one of this review's revisions. */
  readonly comments: readonly Readonly<Record<string, unknown>>[];
  readonly changeRequests: readonly {
    readonly changeRequestId: string;
    readonly commentId: string;
    readonly state: ChangeRequestState;
  }[];
}

export interface ClientReviewListResult {
  readonly ok: true;
  readonly reviews: readonly ClientReviewView[];
}
