// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// PROTO-GAPS rows 2 and 5: the Review workspace places what was built for it. Under the pin
// list sits the change-request dock, with approve and refuse on a proposed request for a reader
// holding `proposal:decide` and a made request opening its task's page; beside the capture under
// review sits the live view, which falls back to its own line when the page can't be framed. A
// media review has no page, so no live view.

import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { LIVE_FALLBACK_LINE } from '../../apps/web/src/screens/projects/review-live-frame.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const MADE_TASK = '66666666-6666-4666-8666-666666666666';

const WITH_REQUESTS = {
  ...REVIEW,
  review: {
    ...REVIEW.review,
    changeRequests: [
      {
        changeRequestId: 'cr-proposed',
        commentId: REVIEW.review.pins[1]?.commentId ?? '',
        state: 'proposed',
        text: 'Lower the phone headline',
        createdTaskId: null,
      },
      {
        changeRequestId: 'cr-made',
        commentId: REVIEW.review.pins[0]?.commentId ?? '',
        state: 'approved',
        text: 'Say e-bikes in the headline',
        createdTaskId: MADE_TASK,
      },
    ],
  },
};

async function drawn(review: unknown) {
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Readonly<
      Record<string, unknown>
    >;
    if (path.endsWith('/review/read')) return Promise.resolve(json(review));
    if (path.endsWith('/review/picture')) {
      return Promise.resolve(json(pictureOf(body['pictureId'])));
    }
    if (path.endsWith('/session/capabilities')) {
      return Promise.resolve(json({ grants: [{ collection: 'proposal', action: 'decide' }] }));
    }
    throw new Error(`unrouted ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const went: string[] = [];
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      navigate={(path) => went.push(path)}
    />,
  );
  await tick();
  await tick();
  await tick();
  return { view, went };
}

it('docks the change requests under the pin list: approve, refuse, and the made task opens', async () => {
  const { view, went } = await drawn(WITH_REQUESTS);
  const dock = view.find('[data-change-requests="ready"]');
  expect(dock).not.toBeNull();
  const order = view.all('[data-pin-row], [data-change-requests]');
  expect(order.at(-1)).toBe(dock);
  const proposed = view.find('[data-change-request="cr-proposed"]');
  expect(proposed?.querySelector('[data-decide="approve"]')?.textContent).toBe('Approve');
  expect(proposed?.querySelector('[data-decide="refuse"]')?.textContent).toBe('Refuse');
  await view.click(`[data-made-task="${MADE_TASK}"] button`);
  expect(went).toEqual([`/task/${MADE_TASK}`]);
});

it('offers the client pin with no request to be filed as a change request', async () => {
  const { view } = await drawn(REVIEW);
  expect(view.find('[data-file-pin]')?.textContent).toContain('File as a change request');
});

it('sets the live view beside the capture under review, falling back to its line', async () => {
  const { view } = await drawn({
    ...REVIEW,
    review: { ...REVIEW.review, pageUrl: 'http://no-embed.example/about' },
  });
  const live = view.all('[data-live-view]');
  expect(live).toHaveLength(2);
  for (const each of live) {
    expect(each.querySelector('[data-capture-picture]')?.getAttribute('aria-label')).toMatch(
      /^Under review/u,
    );
    expect(each.querySelector('[data-live-fallback]')?.textContent).toContain(LIVE_FALLBACK_LINE);
  }
});

it('frames no live view for a media review', async () => {
  const { view } = await drawn({ ...REVIEW, review: { ...REVIEW.review, pageUrl: null } });
  expect(view.all('[data-live-view]')).toHaveLength(0);
  expect(view.all('[data-capture-picture]')).toHaveLength(4);
});
