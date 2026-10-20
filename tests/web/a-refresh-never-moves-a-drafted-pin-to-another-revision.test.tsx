// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105), from review round 2 of #2158: the floor's re-read opens a new revision while a pin
// is drafted on the last one, and the draft never goes out against the new revision.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const nothing = (): void => {};

const original = REVIEW.review.after!;
const third = {
  ...original,
  revisionId: '55555555-5555-4555-8555-000000000003',
  number: 3,
  captures: original.captures.map((capture, at) => ({
    ...capture,
    pictureId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(at + 1).padStart(12, '0')}`,
  })),
};

interface World {
  current: typeof REVIEW;
  readonly sent: Record<string, unknown>[];
}

function clientFor(world: World): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/review/read')) return Promise.resolve(json(world.current));
      if (path.endsWith('/review/picture')) {
        const index = third.captures.findIndex((capture) => capture.pictureId === body.pictureId);
        return Promise.resolve(
          json(pictureOf(index < 0 ? body.pictureId : original.captures[index]?.pictureId)),
        );
      }
      if (path.endsWith('/review/pin_comment')) {
        world.sent.push(body);
        return Promise.resolve(json({ recordId: 'c1', revision: 1 }));
      }
      throw new Error(`Unexpected ${path}`);
    },
  });
}

it('a floor refresh never moves a drafted pin to another revision', async () => {
  const world: World = { current: REVIEW, sent: [] };
  let refresh: () => void = nothing;
  const client = clientFor(world);
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
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
  await tick();
  const picture = view.find('[data-capture-picture="1480"][aria-label^="Under review"]');
  if (picture === null) throw new Error('No picture');
  picture.getBoundingClientRect = () => new DOMRect(0, 0, 1480, 900);
  await act(() => {
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
  });
  await view.type('form textarea', 'This spot on revision two needs fixing');
  world.current = {
    ...REVIEW,
    review: {
      ...REVIEW.review,
      revisions: [...REVIEW.review.revisions, third],
      before: original,
      after: third,
    },
  };
  await act(() => Promise.resolve(refresh()));
  await tick();
  await tick();
  // Either retire the old draft, or keep it bound to the revision it was written against.
  if (view.find('form textarea') !== null) {
    await view.click('form button[type="submit"]');
    await tick();
  }
  expect(world.sent.filter((command) => command['revisionId'] !== original.revisionId)).toEqual([]);
});
