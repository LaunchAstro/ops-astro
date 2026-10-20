// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105), from review round 1 of #2158: review access revoked on the server takes the
// workspace's pictures and pins away on the visible tab's floor, with no other action.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { mount, json } from './perspective-support.tsx';

/** Reads the made-up review until `revoked` says so, then refuses it NOT_FOUND. */
function readerUntilRevoked(revoked: () => boolean, counted: () => void): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) => {
      if (String(url).endsWith('/review/read')) {
        counted();
        return Promise.resolve(
          revoked()
            ? json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 403)
            : json(REVIEW),
        );
      }
      if (String(url).endsWith('/review/picture'))
        return Promise.resolve(json(pictureOf(JSON.parse(String(init?.body)).pictureId)));
      throw new Error('Unexpected read');
    },
  });
}

/** `count` microtask turns, one after another. */
async function turns(count: number): Promise<void> {
  if (count === 0) return;
  await Promise.resolve();
  await turns(count - 1);
}

it('revoked review access removes the pictures and pins on the visible-tab floor', async () => {
  vi.useFakeTimers();
  let revoked = false;
  let reviewReads = 0;
  const client = readerUntilRevoked(
    () => revoked,
    () => {
      reviewReads++;
    },
  );
  const view = await mount(
    SCREENS['agency:review-workspace']({
      client,
      grantKey: 'alpha:ava',
      params: { review: REVIEW_ID },
      notice: null,
      storage: null,
      navigate: () => {},
    }),
  );
  try {
    await act(async () => {
      await turns(10);
    });
    expect(view.text()).toContain('Say e-bikes');
    expect(view.all('[data-capture-picture]')).toHaveLength(4);
    revoked = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(view.text(), `review read count after revocation: ${reviewReads}`).not.toContain(
      'Say e-bikes',
    );
    expect(view.all('[data-capture-picture]')).toHaveLength(0);
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
