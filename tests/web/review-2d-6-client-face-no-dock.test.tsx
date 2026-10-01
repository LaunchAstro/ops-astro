// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-2D-6: the client face has no dock (R17), even for a signed-in person.
// dock-app.test.tsx's "draws no dock signed out or on the client face" only
// mounts /sign-in signed out, so the client-face half went unproven. Here a
// signed-in person with dock panels registered opens a portal address: no
// dock and no dock tab. The same mount on a Hub address draws the tabs, so
// the absence is the face's doing and not a missing registry.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { granted, session, silent, storage } from './mp-2-1-support.tsx';

const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function signedInAt(path: string): Promise<Mounted> {
  const store = storage({ 'ops-astro.session': JSON.stringify(session('alpha')) });
  const page = await mount(
    <App
      path={path}
      navigate={() => {}}
      sessions={new SessionStore(store.like)}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={silent}
      storage={store.like as Storage}
      panels={REGISTRY}
      clientAccess={granted}
    />,
  );
  live.push(page);
  return page;
}

describe('REVIEW-2D-6: no dock on the client face, signed in', () => {
  it('REVIEW-2D-6: a Hub address draws the dock tabs (control)', async () => {
    const page = await signedInAt('/projects/');
    expect(page.all('.dock__tab').length).toBeGreaterThan(0);
  });

  it('REVIEW-2D-6: a portal address draws no .dock and no .dock__tab for a signed-in person', async () => {
    const page = await signedInAt('/portal/acme-dental/');
    expect(page.find('.appbar')?.getAttribute('data-face')).toBe('client');
    expect(page.all('.dock'), 'the client face draws no dock (R17)').toHaveLength(0);
    expect(page.all('.dock__tab'), 'the client face draws no dock tab (R17)').toHaveLength(0);
  });
});
