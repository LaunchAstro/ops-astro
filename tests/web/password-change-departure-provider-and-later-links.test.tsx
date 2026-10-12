// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable unicorn/consistent-function-scoping, require-await -- the proof bodies are kept as written */
//
// Leaving mid-change sends no password update; a sign-in service that did not end the other
// sessions is said so; a sign-in link followed within the loaded page is cleared too; and a
// new password outside 12 to 72 bytes is never sent.

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  changePassword,
  type PasswordChangeRequest,
} from '../../apps/web/src/session/password-change.ts';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';

const GOTRUE = 'http://identity.invalid';

function request(fetch: typeof globalThis.fetch): PasswordChangeRequest {
  return {
    gotrueUrl: GOTRUE,
    email: 'reviewer@example.test',
    businessKey: 'alpha',
    currentPassword: 'synthetic-current-password',
    newPassword: 'synthetic-next-password',
    route: { apiOrigin: '', fetch },
    client: new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      sessionId: 'old-cookie',
      fetch,
    }),
    from: 'old-cookie',
    current: () => true,
    adopt: () => {},
  };
}

it.each(['password confirmation', 'factor verification'])(
  'leaving during the %s sends no password update',
  async (stage) => {
    let current = true;
    let release: (answer: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const at = String(input);
      sent.push(`${init?.method ?? 'GET'} ${at}`);
      if (at.endsWith('/token?grant_type=password'))
        return stage === 'password confirmation'
          ? await held
          : json({ access_token: 'confirm-token' });
      if (at.endsWith('/account/factor/verify')) return await held;
      if (at.endsWith('/user')) return json({ email: 'reviewer@example.test' });
      if (at.includes('/logout?')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${at}`);
    };
    const changing = changePassword({
      ...request(fetch),
      current: () => current,
      ...(stage === 'factor verification' ? { code: '123456' } : {}),
    });
    await settle();
    expect(sent.at(-1)).toContain(stage === 'password confirmation' ? '/token?' : '/factor/verify');
    current = false;
    release(json({ access_token: 'confirm-token', accessToken: 'aal2-token' }));
    const result = await changing;
    expect(result.ok).toBe(false);
    expect(sent.filter((line) => line.startsWith('PUT '))).toEqual([]);
  },
);

it('a sign-in service that did not sign the other sessions out is reported as sessions still open', async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    if (at.endsWith('/token?grant_type=password')) return json({ access_token: 'confirm-token' });
    if (at.endsWith('/user')) return json({ email: 'reviewer@example.test' });
    if (at === '/api/session') return json({ ok: true, session: 'new-cookie' });
    if (at.endsWith('/account/sessions/end-others'))
      return json({ ended: 2, signedOutAtProvider: false });
    if (at === '/api/session/end') return json({ ok: true });
    throw new Error(`Unexpected request: ${at}`);
  };
  expect(await changePassword(request(fetch))).toEqual({ ok: true, othersEnded: false });
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

it('a recovery link followed within the loaded page clears its tokens from the address bar', async () => {
  window.history.replaceState(null, '', '/');
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push(`${String(input)} ${JSON.stringify(init ?? {})}`);
    return await new Promise<Response>(() => {});
  };
  const sessions = new SessionStore(null);
  const view = await mount(
    <Root
      window={window}
      sessions={sessions}
      storage={null}
      gotrueUrl={GOTRUE}
      apiOrigin=""
      fetch={fetch}
    />,
  );
  try {
    // Clicking a link to the loaded document with a different fragment does
    // not reload Root. jsdom emits the browser's hashchange and popstate.
    window.location.hash =
      '#access_token=planted-access&refresh_token=planted-refresh&type=recovery';
    // Browsers, and jsdom, deliver popstate and hashchange in a later task: wait for it.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await settle();
    expect(sent.join('\n')).not.toContain('planted');
    expect(sessions.session).toBeNull();
    expect(view.find('[data-screen="sign-in"]')).not.toBeNull();
    expect(window.location.hash).toBe('');
  } finally {
    await view.unmount();
  }
});

it.each(['x'.repeat(73), '😀'.repeat(19), 'x'.repeat(11)])(
  'a new password outside the byte bounds sends no request to the sign-in service (%s)',
  async (password) => {
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      sent.push(String(input));
      return await new Promise<Response>(() => {});
    };
    const { view } = await open('/settings/password/', { fetch });
    try {
      await view.type('#password-current', 'synthetic-current-password');
      await view.type('#password-new', password);
      await view.type('#password-repeat', password);
      await view.click('[data-password="form"] button[type="submit"]');
      await settle();
      expect(sent.some((at) => at.startsWith(`${GOTRUE}/`))).toBe(false);
      expect(view.find('[role="alert"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  },
);
