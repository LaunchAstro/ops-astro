// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { ChangeRequestDock } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import { MARKER, holding, request, reviewAnswer, standIn, refusal } from './c57-change-request-fixtures.ts';

it.each([
  ['business', 'bravo', 'client-a'],
  ['client review', 'alpha', 'client-b'],
])('a late read discloses no words after a %s switch', async (_kind, business, reviewId) => {
  const first = standIn('alpha');
  const next = standIn(business);
  const view = await mount(<ChangeRequestDock client={first.client} reviewId="client-a" onOpenTask={() => {}} />);
  await view.render(<ChangeRequestDock client={next.client} reviewId={reviewId!} onOpenTask={() => {}} />);
  next.calls.find(c => c.name === 'review.read')!.answer(reviewAnswer([]));
  next.calls.find(c => c.name === 'session.capabilities')!.answer(holding([]));
  await view.render(<ChangeRequestDock client={next.client} reviewId={reviewId!} onOpenTask={() => {}} />);
  first.calls.find(c => c.name === 'review.read')!.answer(reviewAnswer([request()]));
  await view.render(<ChangeRequestDock client={next.client} reviewId={reviewId!} onOpenTask={() => {}} />);
  expect(view.text()).not.toContain(MARKER);
  await view.unmount();
});

it('changing the person client clears the words admitted for the earlier person', async () => {
  const ada = standIn('alpha');
  const noah = standIn('alpha');
  const draw = (client: typeof ada.client) =>
    <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
  const view = await mount(draw(ada.client));
  ada.calls.find(c => c.name === 'review.read')!.answer(reviewAnswer([request()]));
  ada.calls.find(c => c.name === 'session.capabilities')!.answer(holding([['proposal', 'decide']]));
  await view.render(draw(ada.client));
  expect(view.text()).toContain(MARKER);
  await view.render(draw(noah.client));
  expect(noah.calls.some(c => c.name === 'review.read')).toBe(true);
  expect(view.text(), 'Ada\'s client words remain visible before Noah is admitted').not.toContain(MARKER);
  await view.unmount();
});

it('a write from an earlier visit cannot unlock a write on the current visit', async () => {
  const { client, calls } = standIn();
  const draw = (reviewId: string) =>
    <ChangeRequestDock client={client} reviewId={reviewId} onOpenTask={() => {}} />;
  const view = await mount(draw('a'));
  calls.find(c => c.name === 'review.read')!.answer(reviewAnswer([request()]));
  calls.find(c => c.name === 'session.capabilities')!.answer(holding([['proposal', 'decide']]));
  await view.render(draw('a'));
  await view.click('[data-decide="approve"]');
  const oldWrite = calls.find(c => c.name === 'review.decide_change')!;
  await view.render(draw('b'));
  await view.render(draw('a'));
  calls.findLast(c => c.name === 'review.read')!.answer(reviewAnswer([request()]));
  calls.findLast(c => c.name === 'session.capabilities')!.answer(holding([['proposal', 'decide']]));
  await view.render(draw('a'));
  await view.click('[data-decide="refuse"]');
  expect(calls.filter(c => c.name === 'review.decide_change')).toHaveLength(2);
  expect((view.find('[data-decide="refuse"]') as HTMLButtonElement).disabled).toBe(true);
  oldWrite.answer(refusal('CHANGE_REQUEST_ALREADY_DECIDED'));
  await view.render(draw('a'));
  expect((view.find('[data-decide="refuse"]') as HTMLButtonElement).disabled,
    'The older approval response must not clear the in-flight refusal').toBe(true);
  await view.unmount();
});
