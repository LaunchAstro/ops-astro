// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// PR-345.3: a password sign-in the API refuses `AUTH_SECOND_FACTOR_REQUIRED`
// asks for the authenticator code before anything opens. A wrong code says so
// and asks again; cancel signs the half-made sign-in out and goes back to the
// password, emptied. Only a good code opens the session, on its new cookie.

import { describe, expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';

const SUBMIT = '[data-screen="sign-in"] button[type="submit"]';

/** The provider and the API; `factor` says whether the login holds a verified one. */
function world(factor: boolean) {
  const sent: string[] = [];
  let trades = 0;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    const headers = new Headers(init?.headers);
    sent.push(`${at} ${headers.get('x-ops-astro-session') ?? '-'}`);
    if (at.startsWith('http://identity.invalid/token')) return json({ access_token: 'aal1' });
    if (at === '/api/session') {
      trades += 1;
      return json({ ok: true, session: trades === 1 ? 'half' : 'full' });
    }
    if (at.endsWith('/session/person')) {
      if (!factor) return json({ person: { name: 'Mia Hart' } });
      return json(
        { refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] },
        401,
      );
    }
    if (at.endsWith('/account/factor/verify')) {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      if (code === '123456') return json({ accessToken: 'aal2' });
      return json({ refused: true, code: 'SECOND_FACTOR_INVALID', names: [], fixes: [] }, 422);
    }
    return json({ ok: true });
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

async function signInWith(factor: boolean) {
  const { fetch, sent } = world(factor);
  const opened: Session[] = [];
  const view = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      ended={null}
      build={null}
      onSignedIn={(session) => {
        opened.push(session);
      }}
    />,
  );
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'test-password');
  await view.click(SUBMIT);
  await settle();
  return { view, sent, opened };
}

describe('PR-345.3 the sign-in code step', () => {
  it('opens at once when the API serves the password sign-in', async () => {
    const { view, opened } = await signInWith(false);
    expect(view.find('input[autocomplete="one-time-code"]')).toBeNull();
    expect(opened).toEqual([{ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'half' }]);
    await view.unmount();
  });

  it('a wrong code says so and opens nothing; a good one opens the new sign-in', async () => {
    const { view, sent, opened } = await signInWith(true);
    expect(view.find('input[autocomplete="one-time-code"]')).not.toBeNull();
    expect(view.find('#signin-password')).toBeNull();
    await view.type('input[autocomplete="one-time-code"]', '000000');
    await view.click(SUBMIT);
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('SECOND_FACTOR_INVALID');
    expect(opened).toEqual([]);
    expect(view.find('input[autocomplete="one-time-code"]')).not.toBeNull();
    await view.type('input[autocomplete="one-time-code"]', '123456');
    await view.click(SUBMIT);
    await settle();
    expect(opened).toEqual([{ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'full' }]);
    // The aal1 cookie goes once the tab holds the new one; the provider session stays.
    expect(sent).toContain('/api/session/end half');
    expect(sent.some((line) => line.includes('sessions/sign-out'))).toBe(false);
    await view.unmount();
  });

  it('cancel signs the half-made sign-in out and returns to an empty password', async () => {
    const { view, sent, opened } = await signInWith(true);
    await view.type('input[autocomplete="one-time-code"]', '12');
    await view.click('.signin__foot .btn--ghost');
    await settle();
    expect(view.find('input[autocomplete="one-time-code"]')).toBeNull();
    expect((view.find('#signin-password') as HTMLInputElement | null)?.value).toBe('');
    expect(opened).toEqual([]);
    expect(sent).toContain('/api/b/alpha/account/sessions/sign-out half');
    expect(sent).toContain('/api/session/end half');
    expect(sent.some((line) => line.includes('factor/verify'))).toBe(false);
    await view.unmount();
  });
});
