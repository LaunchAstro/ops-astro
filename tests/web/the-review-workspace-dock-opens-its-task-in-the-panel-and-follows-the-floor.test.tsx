// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// From Sol's review of #2235 (S2235-1, S2235-2): the workspace's change-request dock opens a made
// task through the app's task panel, reads again when the workspace's review changes on its floor,
// and a business, client or person switch clears it before the new read is admitted.
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);
const nothing = (): void => {};
const TASK = '66666666-6666-4666-8666-666666666666';
const WORDS = 'Private change request for client A';
const request = (made: boolean) => ({
  changeRequestId: 'sol-request',
  commentId: REVIEW.review.pins[0]!.commentId,
  state: 'approved' as const,
  text: WORDS,
  createdTaskId: made ? TASK : null,
});
const answer = (made: boolean) => ({
  ...REVIEW,
  review: { ...REVIEW.review, changeRequests: [request(made)] },
});
function clientFor(read: () => unknown | Promise<Response>, businessKey = 'alpha') {
  return new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    fetch: async (url, init) => {
      const path = String(url);
      if (path.endsWith('/review/read')) {
        const value = await read();
        return value instanceof Response ? value : json(value);
      }
      if (path.endsWith('/review/picture'))
        return json(pictureOf(JSON.parse(String(init?.body)).pictureId));
      if (path.endsWith('/session/capabilities')) return json({ grants: [] });
      throw new Error(`Unexpected ${path}`);
    },
  });
}

it('a made request opens through the app task panel door', async () => {
  const open = vi.fn();
  const navigate = vi.fn();
  const view = await mount(
    SCREENS['agency:review-workspace']({
      client: clientFor(() => answer(true)),
      grantKey: 'alpha:ava',
      params: { review: REVIEW_ID },
      notice: null,
      storage: null,
      navigate,
      taskPanel: { open, changes: 0 },
    }),
  );
  await tick();
  await view.click(`[data-made-task="${TASK}"] button`);
  expect(
    open.mock.calls.map((call) => call.slice(0, 2)),
    `The task panel was never opened; URL navigations: ${JSON.stringify(navigate.mock.calls)}`,
  ).toEqual([[TASK, 'open']]);
});

it('the dock refreshes when the workspace review changes on its floor', async () => {
  let current = answer(false);
  let refresh: () => void = nothing;
  const view = await mount(
    <ReviewWorkspaceScreen
      client={clientFor(() => current)}
      grantKey="alpha:ava"
      reviewId={REVIEW_ID}
      navigate={() => {}}
      rollup={{
        follow: (run) => {
          refresh = run;
          return () => {};
        },
      }}
    />,
  );
  await tick();
  expect(
    (view.find('[data-change-request="sol-request"]') as HTMLElement | null)?.dataset['phase'],
  ).toBe('pending');
  expect(view.find('[data-made-task]')).toBeNull();
  current = { ...answer(true), review: { ...answer(true).review, path: '/workspace-read-is-new' } };
  await act(() => {
    refresh();
  });
  await tick();
  expect(view.text()).toContain('/workspace-read-is-new');
  expect(
    view.find(`[data-made-task="${TASK}"]`),
    'The workspace has the new review while the dock still says approved, task not made yet',
  ).not.toBeNull();
});

it.each([
  ['business', 'bravo', 'bravo:ava', REVIEW_ID],
  ['client', 'alpha', 'alpha:ava', '55555555-5555-4555-8555-555555555556'],
  ['person', 'alpha', 'alpha:dee', REVIEW_ID],
])(
  'a %s switch clears the workspace dock before the new read is admitted',
  async (_kind, business, grant, review) => {
    const context = {
      client: clientFor(() => answer(true)),
      grantKey: 'alpha:ava',
      params: { review: REVIEW_ID },
      notice: null,
      storage: null,
      navigate: () => {},
    };
    const view = await mount(SCREENS['agency:review-workspace'](context));
    await tick();
    expect(view.text()).toContain(WORDS);
    let deny!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      deny = resolve;
    });
    const next = {
      ...context,
      client: clientFor(() => pending, business!),
      grantKey: grant!,
      params: { review: review! },
    };
    await view.render(SCREENS['agency:review-workspace'](next));
    expect(view.text()).not.toContain(WORDS);
    expect(view.find('[data-made-task]')).toBeNull();
    await act(() => deny(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 403)));
    await tick();
    expect(view.text()).toContain('NOT_FOUND');
    expect(view.text()).not.toContain(WORDS);
  },
);
