// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #487: a screen's own state (a proposal typed into its controls,
// the outcome line of its last write) belongs to the business and person that
// made it. The held-address switch moves the same mounted page to another
// business; nothing typed or said under the first may still be on screen, or
// be one press from being sent, under the second.

import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { dockKey, SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

const views: Mounted[] = [];
afterEach(async () => {
  await Promise.all(views.splice(0).map((view) => view.unmount()));
  window.sessionStorage.clear();
});

const json = (value: unknown, status = 200) => Response.json(value, { status });

function Harness(props: { sessions: SessionStore; fetch: typeof globalThis.fetch }) {
  const [path, navigate] = useState('/sign-in');
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

/** Signed in to alpha on `address`, with bravo's held address on the same page offered. */
async function signedInToAlphaHolding(
  address: string,
  answer: (at: string, init: RequestInit | undefined) => Response | null,
) {
  window.sessionStorage.setItem(
    'ops-astro.return-to',
    JSON.stringify({ address, businessKey: 'bravo', code: 'AUTH_SESSION_EXPIRED' }),
  );
  const sessions = new SessionStore(window.sessionStorage);
  const reply = (input: RequestInfo | URL, init: RequestInit | undefined): Response => {
    const at = String(input);
    if (at.startsWith('http://identity.invalid/token'))
      return json({ access_token: 'provider-token' });
    if (at === '/api/session') return json({ session: 'tab-one' });
    if (at.endsWith('/session/person')) return json({ person: { name: 'Ada' } });
    if (at.endsWith('/session/capabilities'))
      return json({ ok: true, grants: [{ collection: 'spend', action: 'decide' }] });
    if (at.endsWith('/inbox/count')) return json({ owed: 0 });
    if (at.endsWith('/sessions/list')) return json({ sessions: [] });
    if (at.includes('/live')) return new Response(null, { status: 503 });
    return answer(at, init) ?? json({});
  };
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(reply(input, init));
  const view = await mount(<Harness sessions={sessions} fetch={fetch} />);
  views.push(view);
  await view.type('#signin-email', 'ada@example.test');
  await view.type('#signin-password', 'test-password');
  await view.choose('#signin-business', 'alpha');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  expect(sessions.session?.businessKey).toBe('alpha');
  return { view, sessions };
}

async function openDockTab(view: Mounted, label: string) {
  const tab = view
    .all('button')
    .find((button) => button.textContent?.includes(label) && button.closest('main') === null);
  expect(tab).toBeDefined();
  await act(() => {
    (tab as HTMLButtonElement).click();
  });
  await settle();
}

it('business to business, a threshold typed in the docked Settings under one business is not there after the switch', async () => {
  const bravoThresholds: unknown[] = [];
  const { view, sessions } = await signedInToAlphaHolding('/projects/', (at, init) => {
    if (at.endsWith('/b/bravo/settings/set_four_eyes_threshold')) {
      bravoThresholds.push(JSON.parse(String(init?.body)));
      return json({ ok: true });
    }
    return null;
  });
  await openDockTab(view, 'Settings');
  expect(view.find('[data-screen="settings"][data-business="alpha"]')).not.toBeNull();
  await view.type('#settings-four-eyes', '9000');
  expect((view.find('#settings-four-eyes') as HTMLInputElement).value).toBe('9000');
  // The same person had Settings docked under bravo earlier in this tab.
  window.sessionStorage.setItem(
    dockKey('bravo'),
    window.sessionStorage.getItem(dockKey('alpha')) ?? '',
  );

  await view.click('[data-switch="held-address"]');
  await settle();

  expect(sessions.session?.businessKey).toBe('bravo');
  expect(view.find('[data-screen="settings"][data-business="bravo"]')).not.toBeNull();
  expect((view.find('#settings-four-eyes') as HTMLInputElement).value).toBe('');
  await view.click('[data-settings="save-four-eyes"]');
  await settle();
  expect(bravoThresholds).toEqual([]);
});
