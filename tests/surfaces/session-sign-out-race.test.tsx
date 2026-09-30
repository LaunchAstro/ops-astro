// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { mount, settle } from './mount.tsx';

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function Page(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
}): ReactElement {
  const [path, setPath] = useState('/projects/');
  return (
    <App
      path={path}
      navigate={setPath}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={props.fetch}
      storage={null}
    />
  );
}

describe('S0-6 session cookie', () => {
  it('a delayed sign-out cannot clear the next person’s session', async () => {
    const sessions = new SessionStore(null);
    sessions.set({ businessKey: 'alpha', email: 'first@example.test' });
    let cookie: string | null = 'first-person-token';
    let finishOldSignOut: (() => void) | undefined;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${SESSION_PATH}/end`) {
        return await new Promise<Response>((resolve) => {
          finishOldSignOut = () => {
            cookie = null;
            resolve(answer({ ok: true }));
          };
        });
      }
      if (url.startsWith('http://identity.invalid/token')) {
        return answer({ access_token: 'ops-astro-test-only-second-person-token' });
      }
      if (url === SESSION_PATH) {
        const headers = new Headers(init?.headers);
        cookie = headers.get('authorization')?.replace('Bearer ', '') ?? null;
        return answer({ ok: true });
      }
      if (url.includes('/person/list')) return answer({ ok: true, persons: [] });
      if (url.includes('/task/board')) return answer({ ok: true, tasks: [] });
      return answer({ ok: true });
    }) as typeof globalThis.fetch;

    const page = await mount(<Page sessions={sessions} fetch={fetch} />);
    await page.click('.topbar__who button');
    expect(finishOldSignOut).toBeDefined();
    expect(page.find('#signin-email')).not.toBeNull();

    await page.type('#signin-email', 'second@example.test');
    await page.type('#signin-password', 'password');
    await page.click('form.signin__form button[type="submit"]');
    await settle();
    expect(sessions.session?.email).toBe('second@example.test');
    expect(cookie).toBe('ops-astro-test-only-second-person-token');

    finishOldSignOut?.();
    await settle();
    expect(cookie).toBe('ops-astro-test-only-second-person-token');
    await page.unmount();
  });
});
