// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T on Settings ▸ Access (CS-2.19): "Invite a team member" takes a name,
// an address and a role and sends `invitation.create`, the same command the
// API and the command line reach, then reads the list again. It is drawn only
// for a person whose session holds `access:share`; for anyone else it is not
// there and nothing is sent. A refusal is shown in the server's words, under
// the field it names, and what was typed stays. The world is
// `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import {
  ADA,
  MANAGE_AND_SHARE,
  MIA,
  SHARE_ONLY,
  access,
  choose,
  json,
  open,
  refusal,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const FORM = '[data-access="invite"]';

async function fill(view: Awaited<ReturnType<typeof open>>): Promise<void> {
  await view.type(`${FORM} [data-field="name"] input`, 'Ivy Invitee');
  await view.type(`${FORM} [data-field="email"] input`, 'ivy@example.test');
  await choose(view, 'role', 'Administrator');
}

const refused = (): Response => refusal('SCOPE_NOT_GRANTED', 403);

/** The roles the form offers, as their labels. */
async function roles(view: Awaited<ReturnType<typeof open>>): Promise<string[]> {
  await view.click(`${FORM} [data-field="role"] button.sel__btn`);
  return view.all(`${FORM} [data-field="role"] [role="option"]`).map((each) => each.textContent);
}

/** SEC27's refusal of an administrator's invitation, naming `role`. */
const roleRefused = (): Response =>
  json(
    {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: ['role'],
      fixes: ['Only a person with access:manage on the whole business invites an administrator.'],
    },
    403,
  );

const taken = (): Response =>
  json(
    {
      refused: true,
      code: 'UNIQUE_VALUE_TAKEN',
      names: ['email'],
      fixes: ['This address already has a pending invitation.'],
    },
    409,
  );

// eslint-disable-next-line max-lines-per-function -- one stand-in world, and the cases that share it
describe('C39-T invite a team member on Settings ▸ Access', () => {
  it('C39-T invite a team member: name, email and role sent as invitation.create, then the list reread', async () => {
    const api = server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE);
    const view = await open(api.fetch);
    expect(
      view.find('[data-access="invite"]'),
      'the form, for a holder of access:share',
    ).not.toBeNull();
    expect(view.text()).not.toMatch(/mock|sample|placeholder data/iu);
    await fill(view);
    await view.click(`${FORM} button[type="submit"]`);
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/invitation/create',
        body: expect.objectContaining({
          name: 'Ivy Invitee',
          email: 'ivy@example.test',
          role: 'admin',
        }) as unknown,
      },
    ]);
    expect(api.calls.filter((call) => call.url.endsWith('/access/read'))).toHaveLength(2);
    const outcome = view.find('[data-access-outcome]');
    expect(outcome?.getAttribute('role')).toBe('status');
    expect(outcome?.textContent).toContain('Ivy Invitee');
    expect(outcome?.textContent).toContain('pending');
  });

  it('C39-T refusal access:share on the screen: without the key the form is not drawn and nothing is sent', async () => {
    const api = server([json(access([ADA, MIA]))]);
    const view = await open(api.fetch);
    expect(view.find('[data-access="team"]'), 'the screen itself is drawn').not.toBeNull();
    expect(view.find('[data-access="invite"]')).toBeNull();
    expect(view.text()).not.toContain('Invite a team member');
    expect(api.commands()).toEqual([]);
  });

  it('C39-T refusal access:share on the screen: a server refusal is shown in its words and what was typed stays', async () => {
    const api = server([json(access([ADA, MIA]))], refused, MANAGE_AND_SHARE);
    const view = await open(api.fetch);
    await fill(view);
    await view.click(`${FORM} button[type="submit"]`);
    await settle();
    await settle();
    expect(api.commands()).toHaveLength(1);
    expect(api.calls.filter((call) => call.url.endsWith('/access/read'))).toHaveLength(1);
    const outcome = view.find('[data-access-outcome]');
    expect(outcome?.getAttribute('role')).toBe('alert');
    expect(outcome?.textContent).toContain('SCOPE_NOT_GRANTED');
    const name = view.find(`${FORM} [data-field="name"] input`) as HTMLInputElement | null;
    expect(name?.value).toBe('Ivy Invitee');
  });

  it('C39-T invite a team member: a refused field is drawn under that field in the server words', async () => {
    const api = server([json(access([ADA, MIA]))], taken, MANAGE_AND_SHARE);
    const view = await open(api.fetch);
    await fill(view);
    await view.click(`${FORM} button[type="submit"]`);
    await settle();
    expect(view.find(`${FORM} [data-field="email"]`)?.textContent).toContain(
      'already has a pending invitation',
    );
  });

  it('C39-T admin invitation asks access:manage on the screen: without it Administrator is not offered', async () => {
    const api = server([json(access([ADA, MIA]))], undefined, SHARE_ONLY);
    const view = await open(api.fetch);
    expect(view.find(`${FORM}`), 'the form, for a holder of access:share').not.toBeNull();
    expect(await roles(view)).toEqual(['Team member']);
    expect(api.commands()).toEqual([]);
  });

  it('C39-T admin invitation asks access:manage on the screen: with it both roles are offered', async () => {
    const api = server([json(access([ADA, MIA]))], undefined, MANAGE_AND_SHARE);
    const view = await open(api.fetch);
    expect(await roles(view)).toEqual(['Team member', 'Administrator']);
  });

  it('C39-T admin invitation asks access:manage on the screen: the refusal naming role is drawn under Role', async () => {
    const api = server([json(access([ADA, MIA]))], roleRefused, MANAGE_AND_SHARE);
    const view = await open(api.fetch);
    await fill(view);
    await view.click(`${FORM} button[type="submit"]`);
    await settle();
    await settle();
    expect(api.commands()).toHaveLength(1);
    expect(view.find(`${FORM} [data-field="role"]`)?.textContent).toContain(
      'Only a person with access:manage',
    );
    expect(view.find('[data-access-outcome]')?.getAttribute('role')).toBe('alert');
  });
});
