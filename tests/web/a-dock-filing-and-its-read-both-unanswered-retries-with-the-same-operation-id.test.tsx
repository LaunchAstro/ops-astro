// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, Sol S2159-6): a filing whose write and follow-up read both go unanswered
// leaves the dock saying the server could not be reached, never that the requests are not the
// reader's to read, with a way to read again. Once the read answers, the same pin filed in the
// same words is sent under the same operation id, so a filing that did arrive cannot file twice.

import { expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { ChangeRequestDock } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import { holding, pin, reviewAnswer, standIn } from './c57-change-request-fixtures.ts';

const UNAVAILABLE = { unavailable: true, because: 'The API answered 503.' };

it('an unanswered filing and read can be read again and retried under the same operation id', async () => {
  const { client, calls } = standIn();
  const draw = () => <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
  const view = await mount(draw());
  calls.find((c) => c.name === 'session.capabilities')?.answer(holding([]));
  calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([], [pin()]));
  await view.render(draw());
  await view.type('[data-file-pin="pin-9"] textarea', 'Lower the photo on phones');
  await view.click('[data-file-pin="pin-9"] button');
  const first = calls.find((c) => c.name === 'review.propose_change');
  expect(first?.operationId).toBe('op-1');
  first?.answer(UNAVAILABLE);
  await view.render(draw());
  calls.filter((c) => c.name === 'review.read')[1]?.answer(UNAVAILABLE);
  await view.render(draw());

  expect(view.text()).not.toContain('not yours to read');
  expect(view.text()).toContain('The API answered 503.');
  const reads = () => calls.filter((c) => c.name === 'review.read').length;
  expect(reads()).toBe(2);
  await view.click('[data-read-again]');
  expect(reads()).toBe(3);
  calls.filter((c) => c.name === 'review.read')[2]?.answer(reviewAnswer([], [pin()]));
  await view.render(draw());

  await view.type('[data-file-pin="pin-9"] textarea', 'Lower the photo on phones');
  await view.click('[data-file-pin="pin-9"] button');
  const filings = calls.filter((c) => c.name === 'review.propose_change');
  expect(filings.map((c) => c.operationId)).toEqual(['op-1', 'op-1']);
  await view.unmount();
});
