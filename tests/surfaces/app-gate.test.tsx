// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in gate, in the mounted app: which screen each pairing of a route's
// `authenticated` flag and a session draws. Four cells, each pinned by what a
// person sees, so the gate can be rewritten without the rendered states moving.

import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
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
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
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

// UI-STATES: a screen with nothing to draw is drawn as the one empty state
// (DS-PRIM-28 `--block`), and a held address keeps the page head of the
// mockup's reserved-route placeholder: the route's label and an outline chip
// saying the page is not built (PAGE-MAP SHELL SH-40).
describe('the screens with nothing to draw', () => {
  it('draws an unregistered address as the one empty state, with the way on', async () => {
    const view = await open('/nowhere/', true);
    const empty = view.find('[data-outcome="not-found"] > .empty.empty--block');
    expect(empty?.matches('[data-voice="no-rows"]')).toBe(true);
    expect(empty?.querySelector('.empty__title')?.textContent).toBe(
      'No screen is registered at /nowhere/.',
    );
    const way = empty?.querySelector('.empty__action a.sb__addr');
    expect(way?.getAttribute('href')).toBe('/projects/');
    expect(way?.textContent).toBe('Go to Projects');
    await view.unmount();
  });

  it('draws a held address as its page head, the not-built chip and the one empty state', async () => {
    const view = await open('/dashboard/', true);
    expect(view.find('.topbar__title')?.textContent).toBe('Dashboard');
    expect(view.find('.topbar__meta .chip.chip--outline')?.textContent).toBe('Not built yet');
    const empty = view.find('[data-outcome="placeholder"] > .empty.empty--block');
    expect(empty?.querySelector('.empty__title')?.textContent).toBe('Dashboard is not built yet.');
    expect(empty?.querySelector('.empty__desc')?.textContent).toBe(
      'Its address is held for it. It is built by MP-2-10.',
    );
    await view.unmount();
  });

  it('gives a built page no not-built chip', async () => {
    const view = await open('/projects/', true);
    expect(view.find('.topbar__meta .chip')).toBeNull();
    await view.unmount();
  });
});
