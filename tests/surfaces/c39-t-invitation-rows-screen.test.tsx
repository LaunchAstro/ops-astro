// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T on Settings ▸ Access: the business's invitations as `invitation.list`
// answers them, each with its state and its sent and expiry times. A pending
// one has Resend and Revoke, sent as `invitation.resend` and
// `invitation.revoke` by its id, then the list is read again; an accepted,
// revoked or expired one has neither. Without `access:share` the list is
// never asked. The world is `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import {
  ADA,
  MANAGE_AND_SHARE,
  MIA,
  access,
  json,
  open,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const invitation = (id: string, state: string, sentAt: string | null = null) => ({
  invitationId: id,
  name: `Name ${id}`,
  address: `${id}@example.test`,
  role: 'member',
  state,
  createdAt: '2026-09-28T01:00:00.000Z',
  sentAt,
  expiresAt: '2026-10-05T01:00:00.000Z',
});

const LISTED = [
  invitation('i-pending', 'pending', '2026-09-28T01:00:05.000Z'),
  invitation('i-accepted', 'accepted', '2026-09-27T01:00:05.000Z'),
  invitation('i-revoked', 'revoked'),
  invitation('i-expired', 'expired', '2026-09-20T01:00:05.000Z'),
];

const answered = () => server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE, LISTED);

describe('C39-T invitations on Settings ▸ Access', () => {
  it('C39-T invite a team member: each invitation is listed with its state and times, acts on pending alone', async () => {
    const api = answered();
    const view = await open(api.fetch);
    expect(api.lists).toHaveLength(1);
    for (const each of LISTED) {
      const row = view.find(`[data-invitation="${each.invitationId}"]`)?.closest('tr');
      expect(row?.querySelector(`[data-state="${each.state}"]`), each.state).not.toBeNull();
      expect(row?.textContent).toContain(each.address);
      const acts = row?.querySelector('[data-invitation-acts]');
      expect(acts === null ? 'none' : 'both', each.state).toBe(
        each.state === 'pending' ? 'both' : 'none',
      );
    }
    const pending = view.find('[data-invitation="i-pending"]')?.closest('tr')?.textContent;
    expect(pending).toContain('2026-09-28 01:00 UTC');
    expect(pending).toContain('2026-10-05 01:00 UTC');
    const revoked = view.find('[data-invitation="i-revoked"]')?.closest('tr')?.textContent;
    expect(revoked).toContain('Not sent');
    expect(view.text()).not.toMatch(/mock|sample|made-up/iu);
  });

  for (const act of ['resend', 'revoke'] as const) {
    it(`C39-T invite a team member: ${act} is sent as invitation.${act} by its id, then the list reread`, async () => {
      const api = answered();
      const view = await open(api.fetch);
      await view.click(`[data-invitation-acts="i-pending"] [data-act="${act}"] button`);
      await settle();
      await settle();
      expect(api.commands()).toEqual([
        {
          url: `/api/b/alpha/invitation/${act}`,
          body: expect.objectContaining({ invitationId: 'i-pending' }) as unknown,
        },
      ]);
      expect(api.lists).toHaveLength(2);
      expect(view.find('[data-access-outcome]')?.textContent).toContain('Name i-pending');
    });
  }

  it('C39-T refusal access:share on the screen: without the key the invitations are never asked', async () => {
    const api = server([json(access([ADA, MIA]))], undefined, undefined, LISTED);
    const view = await open(api.fetch);
    expect(view.find('[data-access="invitations"]')).toBeNull();
    expect(api.lists).toEqual([]);
  });
});
