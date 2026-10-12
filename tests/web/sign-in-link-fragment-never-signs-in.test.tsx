// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in service's invite or recovery link lands with its tokens in the address's fragment.
// The app opens no session with them: the fragment is cleared from the address bar before the
// first draw, nothing it held is sent anywhere or kept in the tab's history, and the page is the one it would be without it,
// the normal sign-in for someone signed out. An address's own fragment stays.

import { afterEach, expect, it } from 'vitest';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const RECOVERY =
  '#access_token=planted-access&expires_in=3600&refresh_token=planted-refresh&token_type=bearer&type=recovery';
const INVITE = '#access_token=planted-access&refresh_token=planted-refresh&type=invite';

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function land(address: string, signedIn: boolean) {
  window.history.replaceState(null, '', address);
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    sent.push(`${String(url)} ${JSON.stringify(init ?? {})}`);
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  const sessions = new SessionStore(null);
  if (signedIn) sessions.set({ businessKey: 'alpha', email: 'ada@example.test' });
  const view = await mount(
    <Root
      window={window}
      sessions={sessions}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
    />,
  );
  await settle();
  return { view, sent, sessions };
}

it('a recovery link is cleared from the address bar and the sign-in form shows', async () => {
  const { view, sent } = await land(`/${RECOVERY}`, false);
  expect(window.location.hash).toBe('');
  expect(window.location.href).not.toContain('planted');
  expect(view.find('[data-screen="sign-in"]')).not.toBeNull();
  expect(sent.join('\n')).not.toContain('planted');
  await view.unmount();
});

it('an invite link on a working page is cleared and opens no session', async () => {
  const { view, sent } = await land(`/projects/${INVITE}`, false);
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe('/projects/');
  expect(view.find('[data-screen="sign-in"]')).not.toBeNull();
  expect(sent.join('\n')).not.toContain('planted');
  await view.unmount();
});

it('a link fragment landing in a signed-in tab is cleared and the tab keeps its own sign-in', async () => {
  const { view, sent, sessions } = await land(`/settings${RECOVERY}`, true);
  expect(window.location.hash).toBe('');
  expect(sent.join('\n')).not.toContain('planted');
  expect(sessions.session).toMatchObject({ businessKey: 'alpha', email: 'ada@example.test' });
  await view.unmount();
});

it('a fragment that carries no sign-in token is left as it is', async () => {
  const { view } = await land('/projects/#roadmap', false);
  expect(window.location.hash).toBe('#roadmap');
  await view.unmount();
});
