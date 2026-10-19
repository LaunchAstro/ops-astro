// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's carry (#2075, #2014 slice A): a review's pins carried to its new revision, as
// history beside the comment (`review_pin_carries`), never a change to the comment or its
// first anchor. Each pin is found again from its last found spot, its first anchor or its
// newest moved carry before the new revision. It is found only when the page at its width is
// the same document as where it was found (every selector carries as it was), or when its
// quote with its context occurs exactly once in the new page's text (the quote carries, and
// no coordinate). Anything else is an anchor lost: no anchor, nothing guessed, no model call.
// The caller holds the new revision's capture rows locked, so carries onto one revision
// happen one at a time, and a pin already carried there is not carried again.

import type { TenantQuery } from '../tenancy/database.ts';
import { CAPTURE_WIDTHS } from './reviews.ts';
import { readPins, type Anchor, type PinView, type Selector } from './pins.ts';

type Observation = Readonly<Record<string, unknown>>;

const sheetsOf = (sheets: object): string => JSON.stringify(Object.entries(sheets).toSorted());

const sameSheets = (from: unknown, to: unknown): boolean =>
  typeof from === 'object' &&
  from !== null &&
  typeof to === 'object' &&
  to !== null &&
  sheetsOf(from) === sheetsOf(to);

/** The same document with the same stylesheets: every spot on it is where it was. */
const sameDocument = (from: Observation, to: Observation): boolean =>
  typeof from['documentDigest'] === 'string' &&
  from['documentDigest'] === to['documentDigest'] &&
  sameSheets(from['stylesheets'], to['stylesheets']);

/** How often the quote, with its context, occurs in `text`, overlaps counted. */
function occurrences(text: string, quote: Extract<Selector, { type: 'TextQuoteSelector' }>) {
  const whole = `${quote.prefix ?? ''}${quote.exact}${quote.suffix ?? ''}`;
  let count = 0;
  for (let at = text.indexOf(whole); at !== -1; at = text.indexOf(whole, at + 1)) count += 1;
  return count;
}

/**
 * `anchor` found again on the revision `toRevisionId`, from the page it was found on to the
 * new page at the same width; null when it is lost.
 */
export function refind(
  anchor: Anchor,
  pages: { readonly from: Observation | undefined; readonly to: Observation | undefined },
  toRevisionId: string,
): Anchor | null {
  const { from, to } = pages;
  if (to === undefined) return null;
  const at = { source: toRevisionId, width: anchor.width };
  if (from !== undefined && sameDocument(from, to)) return { ...at, selector: anchor.selector };
  const quote = anchor.selector.find((one) => one.type === 'TextQuoteSelector');
  const text = to['text'];
  if (quote === undefined || typeof text !== 'string' || occurrences(text, quote) !== 1) {
    return null;
  }
  return { ...at, selector: [quote] };
}

interface CarryRow {
  readonly comment_id: string;
  readonly from_revision_id: string;
  readonly to_revision_id: string;
  readonly number: number;
  readonly state: 'moved' | 'lost';
  readonly anchor: Anchor | null;
}

/** Everything about a review a carry reads: its revisions, pins, carries and landed pages. */
async function reviewState(tx: TenantQuery, review: CarriedReview) {
  const revisions = await tx.query<{ readonly id: string; readonly number: number }>(
    'select id, number from public.review_revisions where business_id = $1 and review_id = $2',
    [tx.businessId, review.reviewId],
  );
  const carries = await tx.query<CarryRow>(
    `select p.comment_id, p.from_revision_id, p.to_revision_id, v.number, p.state, p.anchor
       from public.review_pin_carries p
       join public.review_revisions v on v.business_id = p.business_id and v.id = p.to_revision_id
      where p.business_id = $1 and p.review_id = $2`,
    [tx.businessId, review.reviewId],
  );
  const landed = await tx.query<{
    readonly revision_id: string;
    readonly width: number;
    readonly observation: Observation;
  }>(
    `select k.revision_id, k.width, k.observation from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
      where k.business_id = $1 and v.review_id = $2 and k.state = 'landed'`,
    [tx.businessId, review.reviewId],
  );
  const numbers = new Map(revisions.map((one) => [one.id, one.number]));
  const pages = new Map(landed.map((one) => [`${one.revision_id}/${one.width}`, one.observation]));
  return { numbers, carries, pages, pins: await readPins(tx, review) };
}

export interface CarriedReview {
  readonly reviewId: string;
  readonly taskId: string;
}

/** A revision a carry goes onto. */
export interface CarryTarget {
  readonly revisionId: string;
  readonly number: number;
}

type State = Awaited<ReturnType<typeof reviewState>>;

/** The pins on revisions before `to` that have no carry onto it yet, oldest first. */
const notYetCarried = (state: State, to: CarryTarget): readonly PinView[] =>
  state.pins.filter(
    (pin) =>
      (state.numbers.get(pin.anchor.source) ?? to.number) < to.number &&
      !state.carries.some(
        (carry) => carry.comment_id === pin.commentId && carry.to_revision_id === to.revisionId,
      ),
  );

/** Where a pin was last found before `to`: its newest moved carry there, or its first anchor. */
function lastFound(state: State, pin: PinView, to: CarryTarget): Anchor {
  const moved = state.carries
    .filter(
      (carry) =>
        carry.comment_id === pin.commentId && carry.number < to.number && carry.anchor !== null,
    )
    .toSorted((a, b) => b.number - a.number);
  return moved[0]?.anchor ?? pin.anchor;
}

/**
 * The review a revision is of and its number, if it has landed at every width; undefined while
 * a width is still to land. The caller has locked the revision's captures.
 */
export async function landedCarryTarget(
  tx: TenantQuery,
  revisionId: string,
): Promise<{ readonly review: CarriedReview; readonly to: CarryTarget } | undefined> {
  const [row] = await tx.query<{
    readonly review_id: string;
    readonly task_id: string;
    readonly number: number;
    readonly widths: readonly number[];
  }>(
    `select v.review_id, c.task_id, v.number,
            array(select k.width from public.review_captures k
                   where k.business_id = v.business_id and k.revision_id = v.id
                     and k.state = 'landed') as widths
       from public.review_revisions v
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where v.business_id = $1 and v.id = $2`,
    [tx.businessId, revisionId],
  );
  if (row === undefined || !CAPTURE_WIDTHS.every((width) => row.widths.includes(width))) {
    return undefined;
  }
  return {
    review: { reviewId: row.review_id, taskId: row.task_id },
    to: { revisionId, number: row.number },
  };
}

/** Who carries: the lease the worker holds, its fence, its actor and its operation. */
export interface CarryBy {
  readonly leaseId: string;
  readonly fence: number;
  readonly actorId: string;
  readonly operationId: string;
}

/**
 * Carry every pin not yet carried onto `to`, which has landed at every width. The caller holds
 * `to`'s capture rows locked and has judged its lease after that wait. The comments carried,
 * each moved or lost.
 */
export async function carryPinsOnto(
  tx: TenantQuery,
  review: CarriedReview,
  to: CarryTarget,
  by: CarryBy,
): Promise<readonly { readonly commentId: string; readonly state: 'moved' | 'lost' }[]> {
  const state = await reviewState(tx, review);
  const carried = [];
  for (const pin of notYetCarried(state, to)) {
    const from = lastFound(state, pin, to);
    const anchor = refind(
      from,
      {
        from: state.pages.get(`${from.source}/${from.width}`),
        to: state.pages.get(`${to.revisionId}/${from.width}`),
      },
      to.revisionId,
    );
    // One insert per pin, one after the other in the caller's transaction.
    // eslint-disable-next-line no-await-in-loop
    const rows = await tx.query<{ readonly comment_id: string }>(
      `insert into public.review_pin_carries
         (business_id, id, review_id, comment_id, from_revision_id, to_revision_id, state,
          anchor, lease_id, fence, operation_id, carried_by_actor_id)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11)
       on conflict (business_id, comment_id, to_revision_id) do nothing
       returning comment_id`,
      [
        tx.businessId,
        review.reviewId,
        pin.commentId,
        from.source,
        to.revisionId,
        anchor === null ? 'lost' : 'moved',
        anchor === null ? null : JSON.stringify(anchor),
        by.leaseId,
        by.fence,
        by.operationId,
        by.actorId,
      ],
    );
    if (rows.length === 1) {
      carried.push({
        commentId: pin.commentId,
        state: anchor === null ? 'lost' : 'moved',
      } as const);
    }
  }
  return carried;
}

/** A pin carried onto the revision under review: lost with no anchor, or found with one. */
export interface CarriedPinView {
  readonly commentId: string;
  readonly audience: PinView['audience'];
  readonly body: string;
  readonly fromRevisionId: string;
  readonly lost: boolean;
  readonly anchor: Anchor | null;
}

/**
 * The pins carried onto `to`, lost first and then by pin, and whether a carry is due: `to`
 * has landed at every width and a pin before it has not been carried onto it. The caller has
 * judged the review.
 */
export async function readCarried(
  tx: TenantQuery,
  review: CarriedReview,
  to: CarryTarget | null,
): Promise<{ readonly carried: readonly CarriedPinView[]; readonly carryDue: boolean }> {
  if (to === null) return { carried: [], carryDue: false };
  const state = await reviewState(tx, review);
  const onto = new Map(
    state.carries
      .filter((carry) => carry.to_revision_id === to.revisionId)
      .map((carry) => [carry.comment_id, carry]),
  );
  const carried = state.pins.flatMap((pin) => {
    const carry = onto.get(pin.commentId);
    if (carry === undefined) return [];
    const { commentId, audience, body } = pin;
    return [
      {
        commentId,
        audience,
        body,
        fromRevisionId: carry.from_revision_id,
        lost: carry.anchor === null,
        anchor: carry.anchor,
      },
    ];
  });
  const landed = CAPTURE_WIDTHS.every((width) => state.pages.has(`${to.revisionId}/${width}`));
  return {
    carried: carried.toSorted((a, b) => Number(b.lost) - Number(a.lost)),
    carryDue: landed && notYetCarried(state, to).length > 0,
  };
}
