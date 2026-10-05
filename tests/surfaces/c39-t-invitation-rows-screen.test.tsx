// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T on Settings ▸ Access: the business's invitations as `invitation.list`
// answers them, each with its state and its sent and expiry times. A pending
// one has Resend and Revoke, sent as `invitation.resend` and
// `invitation.revoke` by its id, then the list is read again; an accepted,
// revoked or expired one has neither. Without `access:share` the list is
// never asked. The world is `access-screen-world.tsx`'s.

import { act as flushed } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import {
  ADA,
  MANAGE_AND_SHARE,
  MIA,
  SHARE_ONLY,
  access,
  json,
  open,
  refusal,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const invitation = (id: string, state: string, sentAt: string | null = null, role = 'member') => ({
  invitationId: id,
  name: `Name ${id}`,
  address: `${id}@example.test`,
  role,
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

/** An answer the case gives when it chooses, so an act stays out until then. */
function heldAnswer() {
  let give: ((response: Response) => void) | null = null;
  const promise = new Promise<Response>((resolve) => {
    give = resolve;
  });
  return { promise, resolve: (response: Response) => give?.(response) };
}

/** Another administrator ended it first. */
const staleRevoke = () => refusal('TRANSITION_NOT_PERMITTED', 409);

const answered = () => server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE, LISTED);

// eslint-disable-next-line max-lines-per-function -- one stand-in world, and the cases that share it
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

  it('C39-T invite a team member: a second click while an act is out sends nothing more', async () => {
    const held = heldAnswer();
    const api = server([json(access([ADA, MIA]))], () => held.promise, MANAGE_AND_SHARE, LISTED);
    const view = await open(api.fetch);
    const acts = '[data-invitation-acts="i-pending"]';
    const resend = view.find(`${acts} [data-act="resend"] button`) as HTMLElement;
    // Two clicks before the page draws again: the second finds the act out.
    await flushed(() => {
      resend.click();
      resend.click();
    });
    // Drawn again: every act of the section is held.
    expect(resend.hasAttribute('disabled'), 'resend').toBe(true);
    expect(view.find(`${acts} [data-act="revoke"] button`)?.hasAttribute('disabled')).toBe(true);
    const sendButton = view.find('[data-access="invite"] button[type="submit"]');
    expect(sendButton?.textContent, 'the form is not the act in flight').toBe('Send invitation');
    expect(sendButton?.hasAttribute('disabled')).toBe(true);
    held.resolve(json({ recordId: 'i-pending', revision: 2 }));
    await settle();
    await settle();
    expect(api.commands().map((call) => call.url)).toEqual(['/api/b/alpha/invitation/resend']);
  });

  it('C39-T invite a team member: a refused act reads the invitations again', async () => {
    const api = server([json(access([ADA, MIA]))], staleRevoke, MANAGE_AND_SHARE, LISTED);
    const view = await open(api.fetch);
    await view.click('[data-invitation-acts="i-pending"] [data-act="revoke"] button');
    await settle();
    await settle();
    expect(api.lists).toHaveLength(2);
    expect(view.find('[data-access-outcome]')?.textContent).toContain('TRANSITION_NOT_PERMITTED');
  });

  it('C39-T invite a team member: a role the screen has no words for is drawn as the server named it', async () => {
    const odd = [invitation('i-odd', 'pending', null, 'constructor')];
    const view = await open(
      server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE, odd).fetch,
    );
    expect(view.find('[data-invitation="i-odd"]')?.closest('tr')?.textContent).toContain(
      'constructor',
    );
  });

  const ADMIN_PENDING = [invitation('i-admin', 'pending', '2026-09-28T01:00:05.000Z', 'admin')];
  const ACTS = '[data-invitation-acts="i-admin"]';

  it("C39-T admin invitation asks access:manage on the screen: without it an admin's invitation has no resend, revoke stays", async () => {
    const api = server([json(access([ADA, MIA]))], undefined, SHARE_ONLY, ADMIN_PENDING);
    const view = await open(api.fetch);
    expect(view.find('[data-access="team"]'), 'the access list asks access:manage').toBeNull();
    expect(view.find(`${ACTS} [data-act="resend"]`)).toBeNull();
    expect(view.find(`${ACTS} [data-act-needs="access:manage"]`)?.textContent).toContain(
      'needs access:manage',
    );
    await view.click(`${ACTS} [data-act="revoke"] button`);
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/invitation/revoke',
        body: expect.objectContaining({ invitationId: 'i-admin' }) as unknown,
      },
    ]);
  });

  it("C39-T admin invitation asks access:manage on the screen: with it an admin's invitation can be resent", async () => {
    const api = server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE, ADMIN_PENDING);
    const view = await open(api.fetch);
    expect(view.find(`${ACTS} [data-act-needs]`)).toBeNull();
    await view.click(`${ACTS} [data-act="resend"] button`);
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/invitation/resend',
        body: expect.objectContaining({ invitationId: 'i-admin' }) as unknown,
      },
    ]);
  });

  it('C39-T refusal access:share on the screen: without the key the invitations are never asked', async () => {
    const api = server([json(access([ADA, MIA]))], undefined, undefined, LISTED);
    const view = await open(api.fetch);
    expect(view.find('[data-access="invitations"]')).toBeNull();
    expect(api.lists).toEqual([]);
  });
});
