// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-promise-executor-return, require-await, unicorn/consistent-function-scoping -- Sol's proof, kept as written */
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SearchPalette } from '../../apps/web/src/search.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { storage, settle } from './mp-2-1-support.tsx';

let page: Mounted | undefined;
afterEach(async () => {
  await page?.unmount();
});
const hit = { id: 'alpha-private-id', key: 'A-1', title: 'Alpha private canary' };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const pause = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 230));
  });
};
function client(businessKey: string, fetch: typeof globalThis.fetch) {
  return new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
}

// Sol OW-096.1 criterion 2, retitled by what it proves; its body is Sol's.
it('business to business search results disappear when the business client changes', async () => {
  const alpha = client('alpha', async () => json({ ok: true, hits: [hit] }));
  const calls: string[] = [];
  const bravo = client('bravo', (input) => {
    calls.push(String(input));
    return new Promise<Response>(() => {});
  });
  const drawn = (source: OperationsClient) => (
    <SearchPalette client={source} onOpen={() => {}} onClose={() => {}} />
  );
  page = await mount(drawn(alpha));
  await page.type('input', 'private');
  await pause();
  expect(page.text()).toContain(hit.title);
  // App.tsx keeps this component mounted across onSwitch and replaces client.
  await page.render(drawn(bravo));
  await pause();
  expect(calls).toEqual(['/api/b/bravo/task/search']);
  expect(page.text()).not.toContain(hit.title);
  expect(page.text()).not.toContain(hit.key);
});

// Sol OW-096.1 criterion 2, retitled by what it proves; its body is Sol's.
it('business to business the mounted App clears Alpha hits on its held-address switch to Bravo', async () => {
  const tab = storage({
    'ops-astro.return-to': JSON.stringify({
      address: '/task/B-1',
      businessKey: 'bravo',
      code: 'AUTH_SESSION_EXPIRED',
    }),
  });
  const sessions = new SessionStore(tab.like);
  const through: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://identity.invalid/token'))
      return json({ access_token: 'made-up-token' });
    if (url === '/api/session') return json({ ok: true, session: 'made-up-session' });
    if (url.endsWith('/session/person')) return json({ ok: true, person: { name: 'Ada' } });
    if (url.endsWith('/bravo/session/capabilities')) return json({ ok: true, grants: [] });
    if (url.endsWith('/alpha/task/search')) return json({ ok: true, hits: [hit] });
    return await new Promise<Response>(() => {});
  };
  function Harness() {
    const [path, navigate] = useState('/sign-in');
    return (
      <App
        path={path}
        navigate={navigate}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={through}
        storage={null}
      />
    );
  }
  page = await mount(<Harness />);
  await page.choose('#signin-business', 'alpha');
  await page.type('#signin-email', 'person@example.test');
  await page.type('#signin-password', 'made-up-password');
  await page.click('form.signin__form button[type="submit"]');
  await settle();
  expect(sessions.session?.businessKey).toBe('alpha');
  await page.click('.appbar__search');
  await page.type('.palette input', 'private');
  await pause();
  expect(page.text()).toContain(hit.title);
  await page.click('[data-switch="held-address"]');
  await settle();
  expect(sessions.session?.businessKey).toBe('bravo');
  expect(page.text()).not.toContain(hit.title);
});
