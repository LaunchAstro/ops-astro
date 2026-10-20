// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105), from review round 1 of #2158: a changed run of text never splits an emoji's
// surrogate pair; a pin answered after the person moved on to another spot leaves the newer
// unsent pin alone; a change of person draws neither the last person's read nor their words.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { changedText } from '../../packages/core-connectors/src/site/captures.ts';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
afterEach(unmountAll);

function clientWith(
  pin: () => Promise<Response> = () => Promise.resolve(json({ recordId: 'c1', revision: 1 })),
) {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url, init) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/review/read')) return json(REVIEW);
      if (path.endsWith('/review/picture')) return json(pictureOf(body.pictureId));
      if (path.endsWith('/review/pin_comment')) return await pin();
      throw new Error(`Unexpected ${path}`);
    },
  });
}

it('a text difference keeps an emoji whole', () => {
  expect(changedText('Offer 😀 today', 'Offer 😁 today')).toStrictEqual({
    at: 6,
    removed: '😀',
    added: '😁',
  });
});

it('an earlier pin answer cannot discard a later unsent pin', async () => {
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  const client = clientWith(async () => await pending);
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      navigate={() => {}}
    />,
  );
  await tick();
  await tick();
  async function mark(width: number) {
    const picture = view.find(`[data-capture-picture="${width}"][aria-label^="Under review"]`);
    if (picture === null) throw new Error('No picture');
    picture.getBoundingClientRect = () => new DOMRect(0, 0, width, width === 1480 ? 900 : 1200);
    await act(() => {
      picture.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    });
  }
  await mark(1480);
  await view.type('form textarea', 'First pin');
  await view.click('form button[type="submit"]');
  await view.click('form button[type="button"]');
  await mark(390);
  await view.type('form textarea', 'Keep my next unsent pin');
  expect((view.find('form textarea') as HTMLTextAreaElement).value).toBe('Keep my next unsent pin');
  await act(() => {
    answer(json({ recordId: 'c1', revision: 1 }));
  });
  await tick();
  await tick();
  expect((view.find('form textarea') as HTMLTextAreaElement | null)?.value).toBe(
    'Keep my next unsent pin',
  );
});

it('a new person gets neither the previous read nor the unsent pin', async () => {
  const client = clientWith();
  const context = {
    client,
    grantKey: 'alpha:ava',
    params: { review: REVIEW_ID },
    notice: null,
    storage: null,
    navigate: () => {},
  };
  const view = await mount(SCREENS['agency:review-workspace'](context));
  await tick();
  await tick();
  expect(view.text()).toContain('Say e-bikes');
  const picture = view.find('[data-capture-picture="1480"][aria-label^="Under review"]');
  if (picture === null) throw new Error('No picture');
  picture.getBoundingClientRect = () => new DOMRect(0, 0, 1480, 900);
  await act(() => {
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
  });
  await view.type('form textarea', 'Private unsent words from ava');
  const denied = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 403)),
  });
  await view.render(
    SCREENS['agency:review-workspace']({ ...context, client: denied, grantKey: 'alpha:dee' }),
  );
  expect(view.text()).not.toContain('Say e-bikes');
  expect(view.text()).not.toContain('Private unsent words from ava');
  expect(view.find('form textarea')).toBeNull();
  await tick();
  expect(view.text()).toContain('NOT_FOUND');
  expect(view.text()).not.toContain('Say e-bikes');
});
