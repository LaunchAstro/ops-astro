// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The page reused when only the fragment changes: a second enrolment link
// arriving in the same document replaces the first, its token is the one
// sent, and its fragment leaves the address bar like the first one's.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const FIRST = 'a'.repeat(43);
const SECOND = 'b'.repeat(43);

afterEach(() => window.history.replaceState(null, '', '/'));

it('a second enrolment link arriving in the same page sends the new token', async () => {
  window.history.replaceState(null, '', `/enrol/#${FIRST}`);
  const sent: unknown[] = [];
  const fetcher: typeof fetch = (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response('{}', { status: 401 }));
  };
  const page = await mount(
    <Root
      window={window}
      sessions={new SessionStore(null)}
      storage={null}
      gotrueUrl="http://auth.test"
      apiOrigin=""
      fetch={fetcher}
    />,
  );
  expect(page.find('[data-screen="enrol"]')).not.toBeNull();
  expect(window.location.hash).toBe('');
  // The browser reuses the document when only its fragment changes.
  act(() => {
    window.history.pushState({ at: 1 }, '', `/enrol/#${SECOND}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { at: 1 } }));
  });
  await page.click('[data-screen="enrol"] button');
  await settle();
  expect(sent).toStrictEqual([{ token: SECOND }]);
});

it('a second enrolment link arriving in the same page clears its fragment', async () => {
  window.history.replaceState(null, '', `/enrol/#${FIRST}`);
  const page = await mount(
    <Root
      window={window}
      sessions={new SessionStore(null)}
      storage={null}
      gotrueUrl="http://auth.test"
      apiOrigin=""
      fetch={fetch}
    />,
  );
  expect(page.find('[data-screen="enrol"]')).not.toBeNull();
  act(() => {
    window.history.pushState({ at: 1 }, '', `/enrol/#${SECOND}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { at: 1 } }));
  });
  expect(window.location.hash).toBe('');
});
