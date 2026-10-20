// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2140, #2075's screen half): the Review workspace draws `review.read`'s carried pins
// on the revision under review. A lost pin sits at the top of the pin list, flagged and still
// open, and draws no spot under review; a pin found again draws there by its carried anchor,
// a quote-only one marks its text and draws no coordinate. A carry still to come says so.

import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { ReviewReadResult } from '../../packages/core-wire/src/index.ts';
import { CARRIED_REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const drawn = async (review: ReviewReadResult) => {
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/review/read')) return Promise.resolve(json(review));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Readonly<
      Record<string, unknown>
    >;
    if (path.endsWith('/review/picture')) {
      return Promise.resolve(json(pictureOf(body['pictureId'])));
    }
    throw new Error(`unrouted ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const view = await mount(
    <ReviewWorkspaceScreen client={client} grantKey="alpha:member" reviewId={REVIEW_ID} />,
  );
  await tick();
  await tick();
  return view;
};

/** The pin numbers drawn on the capture under review at `width`. */
const underReview = (view: Awaited<ReturnType<typeof drawn>>, width: number): string[] =>
  view
    .all(`[data-capture-picture="${String(width)}"][aria-label^="Under review"] [data-pin-spot]`)
    .map((spot) => (spot as SVGElement).dataset['pinSpot'] ?? '');

it('C35-X the workspace puts lost pins first and draws found ones under review', async () => {
  const view = await drawn(CARRIED_REVIEW);

  // The pin list: the lost pin first, flagged and still open; then every pin once, by number.
  const rows = view.all('[data-pin-row]').map((row) => (row as HTMLElement).dataset['pinRow']);
  expect(rows).toEqual(['2', '1', '3', '4', '5']);
  expect((view.find('[data-pin-row="2"]') as HTMLElement | null)?.dataset['pinLost']).toBe('');
  // Each row's number carries its markers; the row is the list item around it.
  const lost = view.find('[data-pin-row="2"]')?.closest('li');
  expect(lost?.textContent).toContain('Anchor lost');
  expect(lost?.textContent).toContain('Still open');
  expect(view.all('[data-pin-lost]')).toHaveLength(1);

  // Under review: pin 1 at its carried spot, pins 4 and 5 as pinned; lost pin 2 nowhere, and
  // quote-only pin 3 marks its text in the list with no coordinate drawn.
  expect(underReview(view, 1480)).toEqual(['1', '4']);
  expect(underReview(view, 390)).toEqual(['5']);
  const carried = view.find(
    '[data-capture-picture="1480"][aria-label^="Under review"] [data-pin-spot="1"] rect',
  );
  expect([carried?.getAttribute('x'), carried?.getAttribute('y')]).toEqual(['120', '200']);
  expect(view.find('[data-pin-row="3"]')?.closest('li')?.querySelector('mark')?.textContent).toBe(
    'Townsville',
  );
  expect(view.find('[data-pin-row="1"]')?.closest('li')?.textContent).toContain(
    'found again on revision 2',
  );
  expect(view.find('[data-carry-due]')).toBeNull();
});

it('C35-X a carry still to come says so, and no carried pin is drawn before it lands', async () => {
  const view = await drawn({
    ...CARRIED_REVIEW,
    review: { ...CARRIED_REVIEW.review, carried: [], carryDue: true },
  });
  expect(view.find('[data-carry-due]')?.textContent).toContain(
    'still to be carried onto revision 2',
  );
  expect(view.all('[data-pin-lost]')).toHaveLength(0);
  expect(underReview(view, 1480)).toEqual(['4']);
});
