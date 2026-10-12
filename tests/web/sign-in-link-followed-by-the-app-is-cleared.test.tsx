// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in service's invite or recovery link followed inside the loaded page by the
// application's own navigation (a pushed or replaced address, which fires neither `popstate`
// nor `hashchange`) is cleared from the address bar and the history entry, as one the tab
// lands on is. An address's own fragment stays.

import { afterEach, expect, it, vi } from 'vitest';
import type { AppProps } from '../../apps/web/src/app-props.ts';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const seen: { navigate?: AppProps['navigate']; path?: string } = {};

vi.mock('../../apps/web/src/App.tsx', () => ({
  App: (props: AppProps) => {
    seen.navigate = props.navigate;
    seen.path = props.path;
    return null;
  },
}));

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

const RECOVERY = '#access_token=planted-access&refresh_token=planted-refresh&type=recovery';
const INVITE = '#access_token=planted-access&type=invite';

it.each([
  ['a recovery link pushed', RECOVERY, false],
  ['an invite link pushed', INVITE, false],
  ['a recovery link replaced', RECOVERY, true],
])('%s by the application leaves no sign-in token in the address', async (_, link, replace) => {
  window.history.replaceState(null, '', '/projects/');
  const view = await mount(
    <Root
      window={window}
      sessions={new SessionStore(null)}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
    />,
  );
  try {
    seen.navigate?.(`/settings/${link}`, replace ? { replace: true } : undefined);
    await settle();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/settings/');
    expect(window.location.href).not.toContain('planted');
    expect(seen.path).toBe('/settings/');
  } finally {
    await view.unmount();
  }
});

it('an address’s own fragment pushed by the application stays', async () => {
  window.history.replaceState(null, '', '/projects/');
  const view = await mount(
    <Root
      window={window}
      sessions={new SessionStore(null)}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
    />,
  );
  try {
    seen.navigate?.('/settings/#roadmap');
    await settle();
    expect(window.location.hash).toBe('#roadmap');
    expect(seen.path).toBe('/settings/#roadmap');
  } finally {
    await view.unmount();
  }
});
