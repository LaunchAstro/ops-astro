// SPDX-License-Identifier: AGPL-3.0-only
//
// Projects > Reviews (MP-8-1): the business's reviews the reader's grant covers, read through
// `review.list`, newest change first, each linked to its workspace at `/projects/reviews/<id>`
// with its client, page, revision count, open pins, open change requests and whether the
// latest revision is approved. Client names come from `client.list` under its own grant: a
// client the reader can't read is "A client", and none is the business's own site.

import type { ReactElement } from 'react';
import { Chip, Empty } from '@launchastro/ui';
import type {
  ClientListResult,
  ReviewListResult,
} from '../../../../../packages/core-wire/src/index.ts';
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

const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

function clientOf(review: Listed, names: ReadonlyMap<string, string>): string {
  if (review.partyId === null) return 'Our own site';
  return names.get(review.partyId) ?? 'A client';
}

/** One review's row: its page as the door to its workspace, its client and its open work. */
function ReviewRow(props: {
  readonly review: Listed;
  readonly names: ReadonlyMap<string, string>;
}): ReactElement {
  const { review, names } = props;
  return (
    <li className="card" data-review={review.reviewId}>
      <a className="sb__addr" href={reviewAddress(review.reviewId)}>
        {named(review)}
      </a>
      <p className="muted" data-review-client>
        {clientOf(review, names)}
      </p>
      <p className="muted">
        {review.path === null ? '' : `${review.path} · `}Revision {review.revisionCount}
        {' · '}
        {counted(review.openPins, 'open pin', 'open pins')}
        {' · '}
        {counted(review.openChangeRequests, 'open change request', 'open change requests')}
      </p>
      {review.latest === null ? null : (
        <Chip tone={review.latest === 'approved' ? 'ok' : 'idle'}>
          {review.latest === 'approved' ? 'Approved' : 'Waiting for a decision'}
        </Chip>
      )}
    </li>
  );
}

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
  const clients = useRead<ClientListResult>({
    grantKey,
    run: () => client.read<ClientListResult>('client.list', {}),
    deps: [client],
  });
  const names = new Map(
    clients.state.outcome === 'ready' && Array.isArray(clients.state.value.clients)
      ? clients.state.value.clients.map((one) => [one.clientId, one.name] as const)
      : [],
  );
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
              <ReviewRow key={review.reviewId} review={review} names={names} />
            ))}
          </ul>
        )}
      </RecordState>
    </section>
  );
}
