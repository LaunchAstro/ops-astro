// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';
import { held } from './sign-in-again-support.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';

// Sol F1-FIX1 criterion 3, retitled by what it proves; its body is Sol's.
it('leaving during the second-factor probe ends the half-made sign-in', async () => {
  const probe = held();
  const sent: string[] = [];
  const opened: Session[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    sent.push(`${url} ${new Headers(init?.headers).get('x-ops-astro-session') ?? '-'}`);
    if (url.startsWith('http://identity.invalid/token'))
      return Promise.resolve(json({ access_token: 'aal1' }));
    if (url === '/api/session') return Promise.resolve(json({ ok: true, session: 'half' }));
    if (url.endsWith('/session/person')) return probe.wait();
    return Promise.resolve(json({ ok: true }));
  };
  const view = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetcher}
      ended={null}
      build={null}
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'test-password');
  await view.click('[data-screen="sign-in"] button[type="submit"]');
  await settle();
  expect(sent).toContain('/api/b/alpha/session/person half');
  await view.unmount();
  await act(async () => {
    probe.answer(
      json({ refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] }, 401),
    );
    await settle();
  });
  expect(opened).toEqual([]);
  expect(
    sent,
    'A session created for the departed sign-in page must be ended at the API and provider',
  ).toContain('/api/b/alpha/account/sessions/sign-out half');
  expect(sent).toContain('/api/session/end half');
});
