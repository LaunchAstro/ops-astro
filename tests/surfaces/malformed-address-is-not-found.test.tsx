// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An address with a broken percent escape is an address that names nothing,
// not a crash. Route matching and the client's name in the app strip both
// decode what the address carries, and both run while the application draws,
// before the sign-in gate, so a malformed link must leave a page a person can
// still use.

import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { frameAt } from '../../apps/web/src/route-views.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount } from './mount.tsx';

// A lone `%`, a cut-off escape, and an escape that is not UTF-8.
const BROKEN = ['%', '%E0%A4%A', '%FF'] as const;

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

const storage = (signedIn: boolean): StorageLike => ({
  getItem: (key) => (signedIn && key === 'ops-astro.session' ? JSON.stringify(SESSION) : null),
  setItem: () => {
    /* nothing kept */
  },
  removeItem: () => {
    /* nothing kept */
  },
});

// Held open, so a signed-in arrival's reads never answer.
const held = (() =>
  new Promise<Response>(() => {
    /* never answers */
  })) as typeof globalThis.fetch;

describe('an address with a broken escape', () => {
  it.each(BROKEN)('matches no route rather than throwing: /task/%s', (escape) => {
    expect(matchRoute(`/task/${escape}`)).toBeNull();
  });

  it.each(BROKEN)('draws an admitted client with no strip name: /clients/%s/', (escape) => {
    const frame = frameAt(`/clients/${escape}/`, 'alpha', () => true);
    expect(frame.refused).toBe(false);
    expect(frame.identity).toBeNull();
  });

  it('still decodes a well-formed task key and client slug', () => {
    expect(matchRoute('/task/TSK%2D1')?.params).toEqual({ key: 'TSK-1' });
    expect(frameAt('/clients/acme%2Dco/', 'alpha', () => true).identity).toEqual({
      mark: 'A',
      name: 'Acme Co',
    });
  });

  it.each([false, true])('draws the not-found page (signed in: %s)', async (signedIn) => {
    const view = await mount(
      <App
        path="/task/%E0%A4%A"
        navigate={() => {
          /* The test drives the address directly. */
        }}
        sessions={new SessionStore(storage(signedIn))}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={held}
        storage={tabStorage()}
      />,
    );
    expect(view.find('[data-outcome="not-found"]')).not.toBeNull();
    await view.unmount();
  });
});
