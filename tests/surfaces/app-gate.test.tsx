// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in gate, in the mounted app: which screen each pairing of a route's
// `authenticated` flag and a session draws. Four cells, each pinned by what a
// person sees, so the gate can be rewritten without the rendered states moving.

import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount } from './mount.tsx';

function storage(seed: Record<string, string> = {}): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

// Held open, so an authenticated screen stays on `loading`.
const fetch = (() =>
  new Promise<Response>(() => {
    /* never answers */
  })) as typeof globalThis.fetch;

function open(path: string, signedIn: boolean) {
  const seed = signedIn ? { 'ops-astro.session': JSON.stringify(SESSION) } : {};
  return mount(
    <App
      path={path}
      navigate={() => {
        /* The test drives the address directly. */
      }}
      sessions={new SessionStore(storage(seed))}
      gotrueUrl="http://identity.invalid"
      apiBase="/api"
      fetch={fetch}
    />,
  );
}

describe('the sign-in gate', () => {
  it('signed out, the sign-in address draws sign-in', async () => {
    const view = await open('/sign-in', false);
    expect(view.find('#signin-email')).not.toBeNull();
    expect(view.text()).not.toContain('You are already signed in.');
    await view.unmount();
  });

  it('signed in, the sign-in address says so and offers the board', async () => {
    const view = await open('/sign-in', true);
    expect(view.find('#signin-email')).toBeNull();
    expect(view.text()).toContain('You are already signed in.');
    await view.unmount();
  });

  it('signed out, an authenticated address draws sign-in', async () => {
    const view = await open('/settings', false);
    expect(view.find('#signin-email')).not.toBeNull();
    await view.unmount();
  });

  it('signed in, an authenticated address draws its screen', async () => {
    const view = await open('/projects/', true);
    expect(view.find('#signin-email')).toBeNull();
    expect(view.text()).not.toContain('You are already signed in.');
    expect(view.find('[data-outcome="loading"]')).not.toBeNull();
    await view.unmount();
  });

  it.each([false, true])(
    'an unregistered address is not found (signed in: %s)',
    async (signedIn) => {
      const view = await open('/nowhere/', signedIn);
      expect(view.find('[data-outcome="not-found"]')).not.toBeNull();
      await view.unmount();
    },
  );
});
