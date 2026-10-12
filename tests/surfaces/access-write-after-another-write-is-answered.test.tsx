// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access holds a write's operation id while its answer is lost and
// lets go of every held id once any write is answered. Raced here across two
// writes: a revoke lost before it reached the server, then a privacy save
// answered; and the delegation confirmation, pressed twice at once, and kept
// then revoked.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { idOf, raceServer, stored } from '../web/write-race-support.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { ACME, ADA, AGENT, MIA, access, choose } from './access-screen-world.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one screen at a time, as React's act needs
    await view.unmount();
  }
});

function world() {
  const record = { agents: [AGENT] as unknown[], health: false };
  const api = raceServer((path, body) => {
    if (path === '/access/read') return { status: 200, body: access([ADA, MIA], record.agents) };
    if (path === '/client/set_privacy') record.health = body['handlesHealth'] === true;
    if (path === '/delegation/revoke') record.agents = [];
    return stored(1);
  });
  return { record, ...api };
}

type World = ReturnType<typeof world>;

async function screen(api: World): Promise<Mounted> {
  const view = await mount(<AccessScreen client={api.client} grantKey="alpha:ada:0" />);
  live.push(view);
  await settle();
  await settle();
  return view;
}

const CONFIRM = '[data-confirm="revoke-delegation"]';
const HEALTH = '[data-privacy-setting="health"] button[role="switch"]';
const SAVE = '[data-access="client-privacy"] button[type="submit"]';

async function saveHealth(view: Mounted): Promise<void> {
  await view.click(HEALTH);
  await view.click(SAVE);
  await settle();
  await settle();
}

const revokes = (api: World) => api.sent.filter((each) => each.path === '/delegation/revoke');

describe('a revoke lost before it reached the server, then another write answered', () => {
  it('holds no id: the revoke pressed again is a new operation', async () => {
    const api = world();
    const view = await screen(api);
    await choose(view, 'privacy-client', ACME.name);
    api.fates.push('unreachable');
    await view.click('[data-revoke="d-1"] button');
    await view.click(`${CONFIRM} [data-act="revoke"] button`);
    await settle();
    await saveHealth(view);
    expect(api.record.health).toBe(true);
    await view.click('[data-revoke="d-1"] button');
    await view.click(`${CONFIRM} [data-act="revoke"] button`);
    await settle();
    await settle();
    expect(revokes(api)).toHaveLength(1);
    const ids = api.sent.map((_, index) => idOf(api.sent, index));
    expect(new Set(ids).size).toBe(2);
    expect(view.find('[data-access-outcome]')?.textContent).toContain('Revoked the delegation');
  });
});

describe('the delegation confirmation', () => {
  it('pressed twice at once sends one revoke', async () => {
    const api = world();
    const view = await screen(api);
    await view.click('[data-revoke="d-1"] button');
    const confirm = view.find(`${CONFIRM} [data-act="revoke"] button`);
    await act(() => {
      for (let press = 0; press < 2; press += 1) {
        confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });
    await settle();
    await settle();
    expect(revokes(api)).toHaveLength(1);
    expect(view.find(CONFIRM)).toBeNull();
  });

  it('kept, then revoked, sends one revoke after the second confirmation only', async () => {
    const api = world();
    const view = await screen(api);
    await view.click('[data-revoke="d-1"] button');
    await view.click(`${CONFIRM} [data-act="keep"] button`);
    await settle();
    expect(view.find(CONFIRM)).toBeNull();
    expect(api.sent).toHaveLength(0);
    await view.click('[data-revoke="d-1"] button');
    expect(api.sent).toHaveLength(0);
    await view.click(`${CONFIRM} [data-act="revoke"] button`);
    await settle();
    await settle();
    expect(revokes(api)).toHaveLength(1);
  });
});
