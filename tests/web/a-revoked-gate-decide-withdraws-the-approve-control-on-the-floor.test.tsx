// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2142): who may approve is read again on the tab's floor, as the review is. A person
// whose gate:decide is revoked while review:read stays loses the approve control on the next
// floor refresh, and sends nothing. Proof rebuilt from Sol's S2208-1.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { MIA, NATHAN } from '../visual/made-up-access.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const nothing = (): void => {};
const READ = { collection: 'review', action: 'read' } as const;
const DECIDE = { collection: 'gate', action: 'decide' } as const;

it('revoking gate:decide withdraws the approve control on the next floor refresh', async () => {
  let grants: readonly (typeof READ | typeof DECIDE)[] = [READ, DECIDE];
  const decides: unknown[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (path.endsWith('/review/read')) return Promise.resolve(json(REVIEW));
    if (path.endsWith('/review/picture')) {
      return Promise.resolve(json(pictureOf(body['pictureId'])));
    }
    if (path.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({ ok: true, personId: NATHAN.personId, businessKey: 'alpha', grants }),
      );
    }
    if (path.endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: [NATHAN, MIA] }));
    }
    if (path.endsWith('/review/decide')) decides.push(body);
    throw new Error(`unrouted ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const refreshes: (() => void)[] = [];
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      rollup={{
        follow: (run) => {
          refreshes.push(run);
          return nothing;
        },
      }}
    />,
  );
  await tick();
  await tick();
  expect(view.find('[data-approve] button')).not.toBeNull();
  grants = [READ];
  await act(async () => {
    for (const refresh of refreshes) refresh();
    await Promise.resolve();
  });
  await tick();
  await tick();
  expect(view.find('[data-decision="2"]')?.textContent).toContain('Undecided');
  expect(view.find('[data-approve]')).toBeNull();
  expect(decides).toEqual([]);
});
