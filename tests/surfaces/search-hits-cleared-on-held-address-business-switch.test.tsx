// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, no-promise-executor-return, require-await -- Sol's proof, kept as written */
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const views: Mounted[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
});
async function open(element: Parameters<typeof mount>[0]) {
  const view = await mount(element);
  views.push(view);
  return view;
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const never = () => new Promise<Response>(() => {});
async function waitForSearch() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 230));
  });
}

function Harness(props: {
  sessions: SessionStore;
  fetch: typeof globalThis.fetch;
  initial: string;
}) {
  const [path, navigate] = useState(props.initial);
  return (
    <App
      path={path}
      navigate={navigate}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={props.fetch}
      storage={window.sessionStorage}
    />
  );
}

function common(at: string): Response | undefined {
  if (at.endsWith('/preference/read')) return json({ preferences: {} });
  if (at.endsWith('/session/person')) return json({ person: { name: 'Ada' } });
  if (at.endsWith('/person/list')) return json({ persons: [] });
  if (at.endsWith('/inbox/read')) return json({ inbox: [] });
  if (at.endsWith('/inbox/count')) return json({ owed: 0 });
  if (at.endsWith('/task/board')) return json({ tasks: [] });
  if (at.includes('/live')) return new Response(null, { status: 503 });
  return undefined;
}

// Sol OW-078.1 criterion 2, retitled by what it proves; its body is Sol's.
it('business to business search hits disappear when the held-address switch changes business', async () => {
  window.sessionStorage.setItem(
    'ops-astro.return-to',
    JSON.stringify({
      address: '/projects/',
      businessKey: 'bravo',
      code: 'AUTH_SESSION_EXPIRED',
    }),
  );
  const sessions = new SessionStore(window.sessionStorage);
  let bravoSearches = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    if (at.startsWith('http://identity.invalid/token'))
      return json({ access_token: 'provider-token' });
    if (at === '/api/session') return json({ session: 'tab-one' });
    if (at.endsWith('/session/capabilities')) return json({ grants: [] });
    if (at.endsWith('/task/search')) {
      if (at.includes('/b/bravo/')) {
        bravoSearches += 1;
        return never();
      }
      return json({
        hits: [{ id: 'alpha-task', key: 'TSK-1', title: 'Alpha confidential canary' }],
      });
    }
    return common(at) ?? json({});
  };
  const view = await open(<Harness sessions={sessions} fetch={fetch} initial="/sign-in" />);
  await view.type('#signin-email', 'ada@example.test');
  await view.type('#signin-password', 'test-password');
  await view.choose('#signin-business', 'alpha');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  expect(view.find('[data-switch="held-address"]')).not.toBeNull();
  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    );
  });
  await view.type('.palette__field', 'canary');
  await waitForSearch();
  expect(view.text()).toContain('Alpha confidential canary');
  // The palette has no focus trap or inert background, so the switch remains reachable by keyboard.
  await view.click('[data-switch="held-address"]');
  await waitForSearch();
  expect(sessions.session?.businessKey).toBe('bravo');
  expect(bravoSearches).toBe(1);
  expect(view.text()).not.toContain('Alpha confidential canary');
});
