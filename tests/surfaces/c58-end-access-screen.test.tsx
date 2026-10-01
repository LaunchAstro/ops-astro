// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's act on Settings ▸ Access: ending a person's access is one confirmed
// act for that person (`access.end`: the login, every session and the grants,
// on the server), then the list is reread. Nothing is sent until it is
// confirmed, and an agent is never offered it: an agent's access ends with its
// delegation. The world is `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import { ADA, MIA, access, json, open, server, unmountAll } from './access-screen-world.tsx';

afterEach(unmountAll);

describe('C58 End access on Settings ▸ Access', () => {
  it('C58 end access: one confirmed act for that person, then the list reread', async () => {
    const api = server([json(access([ADA, MIA])), json(access([ADA]))]);
    const view = await open(api.fetch);
    await view.click(`[data-end="${MIA.personId}"] button`);
    // Nothing is sent before the act is confirmed.
    expect(api.commands()).toEqual([]);
    expect(view.find('[data-confirm="end-access"]')?.textContent).toContain(MIA.name);
    await view.click('[data-confirm="end-access"] [data-act="end"] button');
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/access/end',
        body: expect.objectContaining({ holderId: MIA.personId }) as unknown,
      },
    ]);
    expect(view.find(`[data-person="${MIA.personId}"]`)).toBeNull();
    expect(view.find('[data-access-outcome]')?.textContent).toContain('Mia Alpha');
  });

  it('C58 end access can be called off: nothing is sent', async () => {
    const api = server([json(access([ADA, MIA]))]);
    const view = await open(api.fetch);
    await view.click(`[data-end="${MIA.personId}"] button`);
    await view.click('[data-confirm="end-access"] [data-act="keep"] button');
    expect(view.find('[data-confirm="end-access"]')).toBeNull();
    expect(api.commands()).toEqual([]);
  });

  it('C58 end access: agents are ended through their delegation, never offered End access', async () => {
    const api = server([json(access([ADA, MIA]))]);
    const view = await open(api.fetch);
    expect(view.find('[data-access="agents"] [data-end]')).toBeNull();
  });
});
