// SPDX-License-Identifier: AGPL-3.0-only
//
// Projects > Reviews (MP-8-1): the business's reviews the reader's grant covers, read through
// `review.list`, newest change first, each linked to its workspace at `/projects/reviews/<id>`
// with its revision count and whether the latest revision is approved.

import type { ReactElement } from 'react';
import { Chip, Empty } from '@launchastro/ui';
import type { ReviewListResult } from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { RecordState } from '../../views/record-state.tsx';

type Listed = ReviewListResult['reviews'][number];

/** The workspace's address; the workspace route itself comes with the Review workspace (#2105). */
export const reviewAddress = (reviewId: string): string =>
  `/projects/reviews/${encodeURIComponent(reviewId)}`;

const named = (review: Listed): string =>
  review.pageUrl ?? (review.kind === 'media' ? 'A media review' : 'A page review');

export function ReviewsScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
}): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<ReviewListResult>({
    grantKey,
    run: () => client.read<ReviewListResult>('review.list', {}),
    deps: [client],
    rollup: props.rollup,
    isEmpty: (listed) => listed.reviews.length === 0,
  });
  return (
    <section className="stack" aria-label="Reviews">
      <RecordState
        state={state}
        subject="review list"
        onRetry={reload}
        empty={
          <Empty
            title="No reviews open."
            description="A review opens on a task's page, and shows here once it does."
          />
        }
      >
        {(listed) => (
          <ul className="stack">
            {listed.reviews.map((review) => (
              <li key={review.reviewId} className="card" data-review={review.reviewId}>
                <a className="sb__addr" href={reviewAddress(review.reviewId)}>
                  {named(review)}
                </a>
                <p className="muted">
                  {review.path === null ? '' : `${review.path} · `}Revision {review.revisionCount}
                </p>
                {review.latest === null ? null : (
                  <Chip tone={review.latest === 'approved' ? 'ok' : 'idle'}>
                    {review.latest === 'approved' ? 'Approved' : 'Waiting for a decision'}
                  </Chip>
                )}
              </li>
            ))}
          </ul>
        )}
      </RecordState>
    </section>
  );
}
