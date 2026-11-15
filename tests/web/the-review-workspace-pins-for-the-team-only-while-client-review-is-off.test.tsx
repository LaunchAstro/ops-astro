// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105), from Sol S2158-7 on #2158: client review is switched off (DECISIONS 43), so the
// workspace's pin form offers no client audience and every pin it sends is the team's.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
afterEach(unmountAll);

it('the pin form offers no client audience and sends a team-only pin', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/review/read')) return Promise.resolve(json(REVIEW));
      if (path.endsWith('/review/picture')) return Promise.resolve(json(pictureOf(body.pictureId)));
      if (path.endsWith('/review/pin_comment')) {
        sent.push(body);
        return Promise.resolve(json({ recordId: 'c1', revision: 1 }));
      }
      return Promise.reject(new Error(`Unexpected ${path}`));
    },
  });
  const view = await mount(
    <ReviewWorkspaceScreen client={client} grantKey="alpha:member" reviewId={REVIEW_ID} />,
  );
  await tick();
  await tick();
  const picture = view.find('[data-capture-picture="1480"][aria-label^="Under review"]');
  if (picture === null) throw new Error('No picture');
  picture.getBoundingClientRect = () => new DOMRect(0, 0, 1480, 900);
  await act(() => {
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
  });
  expect(view.find('form')).not.toBeNull();
  expect(view.text()).not.toContain('The client too');
  expect(view.find('form [value="client"]')).toBeNull();
  await view.type('textarea', 'A note for the team');
  await view.click('form button[type="submit"]');
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.['audience']).toBe('internal');
});
