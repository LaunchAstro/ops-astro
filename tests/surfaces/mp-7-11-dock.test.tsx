// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-7-11, the drawer reached from the dock's edge tab in the real
// application. A direct open carries the page's standing scope only: no
// citation, no drafted question, the subject the route names.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

function storage(seed: Record<string, string>): StorageLike {
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

async function app(sessions: SessionStore) {
  return track(
    await mount(
      <App
        path="/settings"
        navigate={() => {
          /* The test drives the address directly. */
        }}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        // Every read stays in flight: this test is about the dock, not the page.
        fetch={() => new Promise<Response>(() => {})}
        storage={tabStorage()}
      />,
    ),
  );
}

describe('MP-7-11 sparkle entry: a direct open from the edge tab', () => {
  it('opens the Agent drawer with the page as its subject, and closes it', async () => {
    const page = await app(
      new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) })),
    );
    expect(page.find('[data-assistant="panel"]')).toBeNull();
    await page.click('[aria-label="Open Agent"]');
    expect(page.find('[data-assistant="panel"]')?.getAttribute('aria-label')).toBe('Agent');
    expect(page.find('[data-assistant="input"]')?.getAttribute('placeholder')).toBe(
      'Ask about this page…',
    );
    expect(page.find('[data-assistant="citation"]')).toBeNull();
    expect(page.find('[aria-label="Close Agent"]')?.getAttribute('aria-expanded')).toBe('true');
    await page.click('[data-assistant="close"]');
    expect(page.find('[data-assistant="panel"]')).toBeNull();
    await page.click('[aria-label="Open Agent"]');
    await page.click('[aria-label="Close Agent"]');
    expect(page.find('[data-assistant="panel"]')).toBeNull();
  });

  it('signed out, there is no Agent tab to open', async () => {
    const page = await app(new SessionStore(storage({})));
    expect(page.find('[aria-label="Open Agent"]')).toBeNull();
  });
});
