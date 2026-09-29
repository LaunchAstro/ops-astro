// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount } from './mount.tsx';

vi.mock('../../apps/web/src/panels.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/web/src/panels.ts')>();
  return {
    ...actual,
    dockTabs: () => [{ ...actual.dockTabs()[0], count: '120' }],
  };
});

it('a derived count paints when its dock tab registers', async () => {
  const session = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
  const held = new Map([['ops-astro.session', JSON.stringify(session)]]);
  const page = await mount(
    <App
      path="/projects/"
      navigate={() => undefined}
      sessions={
        new SessionStore({
          getItem: (key) => held.get(key) ?? null,
          setItem: (key, value) => {
            held.set(key, value);
          },
          removeItem: (key) => {
            held.delete(key);
          },
        })
      }
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch}
      storage={null}
    />,
  );
  try {
    expect(page.find('.dock__tab')?.textContent).toContain('120');
  } finally {
    await page.unmount();
  }
});
