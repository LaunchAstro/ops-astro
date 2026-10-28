// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's Projects > Reviews (PROTO-GAPS row 7): the reviews the reader's grant covers,
// read through `review.client_list`, each with its current revision, whether it is approved,
// the client comments and pins on it and the state of each change request. Only what the
// server sent: it never reads the team's review, its pictures or its change requests' text.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  ClientReviewListResult,
  ClientReviewView,
} from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { RecordState } from '../../views/record-state.tsx';

const CHANGE_WORDS = {
  proposed: 'Change proposed',
  approved: 'Change approved',
  refused: 'Change refused',
} as const;

const named = (review: ClientReviewView): string =>
  review.pageUrl ?? (review.kind === 'media' ? 'A media review' : 'A page review');

const decision = (review: ClientReviewView): string =>
  review.approved === null
    ? 'Not approved yet'
    : `Approved ${review.approved.decidedAt.slice(0, 10)}`;

const placed = (comment: Readonly<Record<string, unknown>>): string | null => {
  const anchor = comment['anchor'] as { readonly width?: unknown } | undefined;
  if (anchor === undefined) return null;
  return anchor.width === 390 ? 'Pinned on the phone view' : 'Pinned on the laptop view';
};

function Review(props: { readonly review: ClientReviewView }): ReactElement {
  const { review } = props;
  return (
    <li className="card stack" data-client-review={review.reviewId}>
      <span className="sb__addr">{named(review)}</span>
      <p className="muted">
        {review.revision === null ? 'No revision yet' : `Revision ${review.revision}`} ·{' '}
        <span data-decision={review.approved === null ? 'open' : 'approved'}>
          {decision(review)}
        </span>
      </p>
      {review.comments.length === 0 ? (
        <Empty look="inline" title="No comments for you on this review." />
      ) : (
        <ul className="stack">
          {review.comments.map((comment) => {
            const id = String(comment['id']);
            const request = review.changeRequests.find((each) => each.commentId === id);
            const where = placed(comment);
            return (
              <li key={id} data-client-comment={id}>
                <p className="card__body">{String(comment['body'] ?? '')}</p>
                {where === null ? null : <p className="muted">{where}</p>}
                {request === undefined ? null : (
                  <p className="muted" data-change-state={request.state}>
                    {CHANGE_WORDS[request.state]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ClientReviewsScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<ClientReviewListResult>({
    grantKey,
    run: () => client.read<ClientReviewListResult>('review.client_list', {}),
    deps: [client],
    rollup: tabRollupFloor(),
    isEmpty: (listed) => listed.reviews.length === 0,
  });
  return (
    <section className="stack" aria-label="Reviews" data-page="portal:projects/reviews">
      <RecordState
        state={state}
        subject="review list"
        onRetry={reload}
        empty={
          <Empty
            title="No reviews for you yet."
            description="When we ask you to look over a page, it shows here."
          />
        }
      >
        {(listed) => (
          <ul className="stack">
            {listed.reviews.map((review) => (
              <Review key={review.reviewId} review={review} />
            ))}
          </ul>
        )}
      </RecordState>
    </section>
  );
}
