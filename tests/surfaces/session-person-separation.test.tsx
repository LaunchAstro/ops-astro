// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { SESSION_COOKIE } from '../../packages/core-wire/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';
import { mount, settle } from './mount.tsx';

const ISSUER: string = TEST_ISSUER;
const tokenFor = (subject: string) => {
  const now = Math.floor(Date.now() / 1000);
  return signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
  });
};
const task = (title: string) => ({
  id: '11111111-1111-4111-8111-111111111111',
  key: 'TSK-1',
  title,
  state: null,
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
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
      gotrueUrl={ISSUER}
      apiOrigin=""
      fetch={props.fetch}
      storage={null}
    />
  );
}

describe('S0-6 isolation', () => {
  it('another person’s cookie cannot show their client data in the first person’s tab', async () => {
    const otherToken = await tokenFor('second-person');
    const database = {
      withBusiness: () => Promise.reject(new Error('unexpected database call')),
    } as unknown as Database;
    const api = createApi({
      database,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
      executeRead: ((
        _db: unknown,
        _business: string,
        presented: { subject: string },
        request: { read: string },
      ) =>
        Promise.resolve(
          request.read === 'task.board'
            ? { ok: true, tasks: [task(`${presented.subject} private client task`)] }
            : { ok: true, persons: [] },
        )) as never,
      executeCommand: (() => Promise.reject(new Error('unexpected command'))) as never,
    });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', `${SESSION_COOKIE}=${otherToken}`);
      return await api.fetch(
        new Request(new URL(String(input), 'http://api.test'), { ...init, headers }),
      );
    }) as typeof globalThis.fetch;

    const sessions = new SessionStore(null);
    sessions.set({ businessKey: 'alpha', email: 'first@example.test' });
    const page = await mount(<Page sessions={sessions} fetch={fetch} />);
    await settle();
    await settle();
    expect(page.text()).toContain('first@example.test');
    expect(page.text()).not.toContain('second-person private client task');
    await page.unmount();
  });
});
