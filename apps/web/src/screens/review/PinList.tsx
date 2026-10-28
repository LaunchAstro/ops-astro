// SPDX-License-Identifier: AGPL-3.0-only
//
// The Review workspace's pins (C35, #2105, #2140): every pin numbered as the panes number it,
// and `review.read`'s carried pins on the revision under review. A pin whose anchor was lost
// sits first, flagged and still open; one found again says where, a quote-only one marking its
// text. A carry still to come says so. Pins found again are drawn by their carried anchor.

import type { ReactElement } from 'react';
import { Card, Chip, Empty, ListRow } from '@launchastro/ui';
import type { ReviewReadResult } from '../../../../../packages/core-wire/src/index.ts';
import type { Pin } from './review-geometry.ts';

type Review = ReviewReadResult['review'];
type Carried = Review['carried'][number];
export type Numbered = readonly (readonly [number, Pin])[];

/**
 * Each pin by its number, then each pin found again, numbered as its pin, by its carried anchor
 * on the new revision, in number order. A lost pin has no anchor and is drawn nowhere new.
 */
export function drawnPins(review: Review, numbered: Numbered): Numbered {
  const byComment = new Map(numbered.map((each) => [each[1].commentId, each] as const));
  const found = review.carried.flatMap((carry) => {
    const pinned = byComment.get(carry.commentId);
    return carry.anchor === null || pinned === undefined
      ? []
      : [[pinned[0], { ...pinned[1], anchor: carry.anchor }] as const];
  });
  return [...numbered, ...found].toSorted((left, right) => left[0] - right[0]);
}

/** Where a carried pin is now: found again, by its text alone when it has no coordinate. */
function Carry(props: { readonly carry: Carried; readonly revision: string }): ReactElement {
  const { carry, revision } = props;
  if (carry.lost) return <>, its anchor not found on revision {revision}</>;
  const quoted = carry.anchor?.selector.find((each) => each.type === 'TextQuoteSelector');
  const spotted = carry.anchor?.selector.some((each) => each.type === 'FragmentSelector');
  return spotted === true || quoted === undefined ? (
    <>, found again on revision {revision}</>
  ) : (
    <>
      , found by its text on revision {revision}: <mark>{quoted.exact}</mark>
    </>
  );
}

function PinRow(props: {
  readonly number: number;
  readonly pin: Pin;
  readonly carry: Carried | undefined;
  readonly from: string;
  readonly revision: string;
}): ReactElement {
  const { number, pin, carry } = props;
  const audience = <Chip>{pin.audience === 'client' ? 'Client sees it' : 'Team only'}</Chip>;
  const lost = carry?.lost === true;
  return (
    <ListRow
      look="record"
      lead={
        <span className="marker" data-pin-row={number} data-pin-lost={lost ? '' : undefined}>
          {number}
        </span>
      }
      title={pin.body}
      meta={
        <>
          {pin.anchor.width === 390 ? 'Phone' : 'Laptop'}, revision {props.from}
          {carry === undefined ? null : <Carry carry={carry} revision={props.revision} />}
        </>
      }
      trail={
        lost ? (
          <span className="spread">
            <Chip tone="warn">Anchor lost</Chip>
            <Chip>Still open</Chip>
            {audience}
          </span>
        ) : (
          audience
        )
      }
    />
  );
}

export function PinList(props: {
  readonly review: Review;
  readonly numbered: Numbered;
}): ReactElement {
  const { review } = props;
  const numberOf = (source: string): string =>
    String(review.revisions.find((each) => each.revisionId === source)?.number ?? '?');
  const carried = new Map(review.carried.map((carry) => [carry.commentId, carry]));
  const lost = ([, pin]: Numbered[number]): boolean => carried.get(pin.commentId)?.lost === true;
  const listed = [...props.numbered.filter(lost), ...props.numbered.filter((each) => !lost(each))];
  const revision = review.after === null ? '?' : String(review.after.number);
  return (
    <Card title="Pins" flush>
      {review.carryDue ? (
        <p className="t-2" data-carry-due>
          Pins from earlier revisions are still to be carried onto revision {revision}.
        </p>
      ) : null}
      {listed.length === 0 ? (
        <Empty
          title="No pins yet"
          description="Click a spot on a capture under review to pin a comment there."
          look="inline"
        />
      ) : (
        <ul>
          {listed.map(([number, pin]) => (
            <PinRow
              key={pin.commentId}
              number={number}
              pin={pin}
              carry={carried.get(pin.commentId)}
              from={numberOf(pin.anchor.source)}
              revision={revision}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
