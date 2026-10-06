// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { act } from 'react';
import { expect, it } from 'vitest';
import { drawScreen } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';

const list = (when: string) => ({
  sessions: [
    { sessionId: 'this', current: true, firstSeenAt: when, lastSeenAt: when },
    { sessionId: 'other', current: false, firstSeenAt: when, lastSeenAt: when },
  ],
});

// Sol OW-083.9 criterion 5, retitled by what it proves; its body is Sol's.
it('a late old-business session ending cannot strand the new-business sessions read', async () => {
  let finish: ((answer: Response) => void) | undefined;
  const ending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const reader = (businessKey: string, when: string) =>
    new OperationsClient({
      origin: '',
      businessKey,
      signedIn: true,
      fetch: async (url) => {
        if (String(url).endsWith('/sessions/end-others')) return ending;
        if (String(url).endsWith('/sessions/list')) return json(list(when));
        return new Promise<Response>(() => {});
      },
    });
  const match = matchRoute('/settings');
  if (match?.id !== 'agency:settings') throw new Error('Settings route missing');
  const screen = (client: OperationsClient) =>
    drawScreen(match, {
      client,
      grantKey: client.businessKey,
      notice: null,
      storage: null,
      navigate: () => {},
    });
  const page = await mount(screen(reader('alpha', '2026-10-01T01:00:00Z')));
  try {
    await settle();
    await page.click('[data-sessions="end-others"] button');
    await page.click('[data-confirm="end-others"] [data-act="end"] button');
    await page.render(screen(reader('bravo', '2026-10-02T02:00:00Z')));
    await settle();
    expect(page.find('[data-sessions="list"]')?.textContent).toContain('2026-10-02');
    await act(async () => {
      finish?.(json({ ended: 1, signedOutAtProvider: true }));
    });
    await settle();
    expect(
      page.find('[data-sessions="list"]')?.textContent ?? '',
      "Bravo answered its list, so Alpha's late response must not leave it loading",
    ).toContain('2026-10-02');
  } finally {
    await page.unmount();
  }
});
