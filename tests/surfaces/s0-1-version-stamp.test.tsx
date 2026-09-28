// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-1 version stamp`, the template half (ticket S0-1, supporting line C2):
// the page template shows the build identifier in one fixed place, the one the
// browser rows read (`BUILD_SELECTOR`), and an unstamped build says so rather
// than drawing nothing. The build half is `tests/ci/s0-1-version-stamp.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { Shell } from '../../packages/ui/src/index.ts';
import { BUILD_SELECTOR } from '../browser/served-build.ts';
import { mount, settle } from './mount.tsx';

const STAMP = '0123456789ab';

function shell(build: string | null) {
  return (
    <Shell
      face="agency"
      rail={[{ id: 'agency:projects-board', label: 'Projects', href: '/projects/' }]}
      here="/projects/"
      title="Projects"
      dock={[]}
      onDockTab={() => {
        /* No panel in this test. */
      }}
      seated={false}
      build={build}
    >
      <p>content</p>
    </Shell>
  );
}

const emptyStorage = (): StorageLike => ({
  getItem: () => null,
  setItem: () => {
    /* Nothing is kept. */
  },
  removeItem: () => {
    /* Nothing is kept. */
  },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('S0-1 version stamp', () => {
  it('the page template shows the build in one fixed place, the rail', async () => {
    const view = await mount(shell(STAMP));
    const stamps = view.all(BUILD_SELECTOR);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.getAttribute('data-build')).toBe(STAMP);
    expect(stamps[0]?.textContent).toContain(STAMP);
    expect(stamps[0]?.closest('nav.rail')).not.toBeNull();
    await view.unmount();
  });

  it('an unstamped build says so, and the fixed place is still there', async () => {
    const view = await mount(shell(null));
    const stamps = view.all(BUILD_SELECTOR);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.getAttribute('data-build')).toBe('');
    expect(stamps[0]?.textContent).toBe('Build not stamped');
    await view.unmount();
  });

  it('the application draws the stamp its build defined, signed in or not', async () => {
    vi.stubEnv('VITE_OPS_ASTRO_BUILD', STAMP);
    const view = await mount(
      <App
        path="/sign-in"
        navigate={() => {
          /* The test drives the address directly. */
        }}
        sessions={new SessionStore(emptyStorage())}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch}
        storage={tabStorage()}
      />,
    );
    await settle();
    expect(view.find(BUILD_SELECTOR)?.getAttribute('data-build')).toBe(STAMP);
    await view.unmount();
  });
});
