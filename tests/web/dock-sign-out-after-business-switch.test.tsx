// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim proof (SL06 x batch 1 join), criterion MP-3-1 / MP-3-5 "the
// stored row belongs to one person in one business ... Sign-out removes it"
// (apps/web/src/dock/open-set.ts, apps/web/src/session/token.ts dockKey).
//
// A person signs in to Alpha and opens a dock panel: the tab keeps Alpha's
// open set. They take the held-address switch to Bravo (App.onSwitch keeps the
// sign-in and changes only the business) and then sign out. Sign-out must
// remove every dock row that sign-in wrote, not only the one for the business
// it happened to end in.

import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, dockKey } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle, silent, storage } from './mp-2-1-support.tsx';

const HELD = {
  'ops-astro.return-to': JSON.stringify({
    address: '/task/TSK-1',
    businessKey: 'bravo',
    code: 'AUTH_SESSION_EXPIRED',
  }),
};

const world = (async (url: string | URL, init?: RequestInit) => {
  const at = String(url);
  if (at.startsWith('http://identity.invalid/token')) return json({ access_token: 'fresh-token' });
  if (at === '/api/session') return json({ ok: true, session: 'fresh-session' });
  if (at.startsWith('/api/b/bravo/session/capabilities')) {
    return json({ ok: true, personId: 'p', businessKey: 'bravo', grants: [] });
  }
  return await silent(url, init);
}) as unknown as typeof fetch;

describe('MP-3-1 sign-out removes the dock', () => {
  it('Opus interim proof, criterion MP-3-1: sign-out after a business switch leaves no dock row of the business it left', async () => {
    const tab = storage(HELD);
    const sessions = new SessionStore(tab.like);
    function Harness(): ReactElement {
      const [path, setPath] = useState('/sign-in');
      return (
        <App
          path={path}
          navigate={setPath}
          sessions={sessions}
          gotrueUrl="http://identity.invalid"
          apiOrigin=""
          fetch={world}
          // One tab: the session and the dock share its storage, as main.tsx wires them.
          storage={tab.like as Storage}
          clientAccess={() => true}
        />
      );
    }
    const view = await mount(<Harness />);
    await view.choose('#signin-business', 'alpha');
    await view.type('#signin-email', 'mia@alpha.local');
    await view.type('#signin-password', 'whatever-it-is');
    await view.click('form.signin__form button[type="submit"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('alpha');

    // The person opens a panel in Alpha: the tab now keeps Alpha's open set.
    await view.click('.dock__tab[data-panel="settings"]');
    await settle();
    expect(tab.held.get(dockKey('alpha'))).toContain('mia@alpha.local');

    // The held-address switch to Bravo, then sign-out.
    await view.click('[data-switch="held-address"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');
    // Sign-out is in the person menu (C23).
    await view.click('.appbar .who__trigger');
    expect(view.find('.who__menu button[role="menuitem"]')?.textContent).toBe('Sign out');
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    expect(sessions.session).toBeNull();

    // Nothing of the signed-out person's dock is left in the tab.
    expect([...tab.held.keys()].filter((key) => key.startsWith('ops-astro.dock.'))).toEqual([]);
    await view.unmount();
  });
});
