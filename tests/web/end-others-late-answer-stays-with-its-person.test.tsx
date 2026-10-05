// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// "Sign out other sessions" pressed by Ada and answered after Ben's sign-in
// took the screen, in the same business (#547): the answer is Ada's alone. It
// neither reloads Ben's list nor tells Ben that sessions were ended.

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { OwnSessions } from '../../apps/web/src/screens/settings/sessions.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

const list = (when: string) => ({
  sessions: [
    { sessionId: 'this', current: true, firstSeenAt: when, lastSeenAt: when },
    { sessionId: 'other', current: false, firstSeenAt: when, lastSeenAt: when },
  ],
});

function reader(when: string, ending: Promise<Response>) {
  const lists: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL) => {
      if (String(url).endsWith('/sessions/end-others')) return ending;
      lists.push(String(url));
      return Promise.resolve(Response.json(list(when)));
    }) as typeof globalThis.fetch,
  });
  return { client, lists };
}

it('a late end-others answer for one person neither reloads nor speaks to the next', async () => {
  let finish!: (answer: Response) => void;
  const ending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const ada = reader('2026-10-01T01:00:00Z', ending);
  const ben = reader('2026-10-02T02:00:00Z', new Promise<Response>(() => {}));
  const page = await mount(<OwnSessions client={ada.client} grantKey="alpha:ada:0" />);
  try {
    await settle();
    await page.click('[data-sessions="end-others"] button');
    await page.click('[data-confirm="end-others"] [data-act="end"] button');
    await page.render(<OwnSessions client={ben.client} grantKey="alpha:ben:0" />);
    await settle();
    expect(page.find('[data-sessions="list"]')?.textContent).toContain('2026-10-02');
    const benReads = ben.lists.length;
    await act(async () => {
      finish(Response.json({ ended: 1, signedOutAtProvider: true }));
      await ending;
    });
    await settle();
    expect(ben.lists, 'Ada’s answer reloaded Ben’s sessions').toHaveLength(benReads);
    expect(page.find('[data-sessions-outcome]'), 'Ben was told Ada’s outcome').toBeNull();
    expect(page.find('[data-sessions="end-others"] button')?.textContent).not.toContain('Signing');
  } finally {
    await page.unmount();
  }
});
