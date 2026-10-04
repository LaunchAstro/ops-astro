// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';
import { held } from './sign-in-again-support.tsx';

// Sol F1-FIX2 criterion 3, retitled by what it proves; its bodies are Sol's.
async function departed() {
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
  await settle();
  return { sent, opened, probe };
}

it('a successful probe after departure cannot open the forgotten sign-in', async () => {
  const { sent, opened, probe } = await departed();
  await act(async () => {
    probe.answer(json({ person: { name: 'Mia' } }));
    await settle();
  });
  expect(opened, 'The departed sign-in page must not adopt its late session.').toEqual([]);
  expect(sent).toContain('/api/b/alpha/account/sessions/sign-out half');
  expect(sent).toContain('/api/session/end half');
});

it('departure ends the issued sign-in while its factor probe remains stalled', async () => {
  const { sent, probe } = await departed();
  try {
    expect(sent, 'Cleanup must not depend on the stalled probe answering.').toContain(
      '/api/b/alpha/account/sessions/sign-out half',
    );
    expect(sent).toContain('/api/session/end half');
  } finally {
    await act(async () => {
      probe.answer(
        json({ refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] }, 401),
      );
      await settle();
    });
  }
});
