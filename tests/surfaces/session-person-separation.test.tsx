// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';
import { mount, type Mounted } from './mount.tsx';
import { until } from '../web/screen-until.tsx';

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
/** A board row as `task.board` answers it (MP-5-8), titled `title`. */
const task = (title: string) => ({
  id: '11111111-1111-4111-8111-111111111111',
  key: 'TSK-1',
  title,
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  board: null,
  rank: { number: null, score: null, calc: '' },
  adHoc: false,
  clientAccess: false,
  stage: null,
  clientSet: false,
  steps: [],
  time: null,
  comments: { client: 0, mentions: 0, latest: null },
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

/** The browser's one cookie jar, shared by every tab: each named sign-in's cookie. */
const jar = (...tokens: readonly string[]): string =>
  tokens.map((token) => `${cookieNameFor(sessionIdOf(token))}=${token}`).join('; ');

/**
 * The API on a database it must not touch: `task.board` answers one private
 * task titled for the person the request was taken as, and every subject a
 * board read is answered for is recorded.
 */
function serving(): { readonly api: ReturnType<typeof createApi>; readonly boards: string[] } {
  const boards: string[] = [];
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
    ) => {
      if (request.read === 'task.board') boards.push(presented.subject);
      return Promise.resolve(
        request.read === 'task.board'
          ? { ok: true, tasks: [task(`${presented.subject} private client task`)] }
          : { ok: true, persons: [] },
      );
    }) as never,
    executeCommand: (() => Promise.reject(new Error('unexpected command'))) as never,
  });
  return { api, boards };
}

/** A tab signed in as `email` under `token`'s named session, sending `cookies` on every call. */
async function tab(
  api: ReturnType<typeof createApi>,
  cookies: string,
  email: string,
  token: string,
) {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookies);
    return await api.fetch(
      new Request(new URL(String(input), 'http://api.test'), { ...init, headers }),
    );
  }) as typeof globalThis.fetch;
  const sessions = new SessionStore(null);
  sessions.set({ businessKey: 'alpha', email, sessionId: sessionIdOf(token) });
  return await mount(<Page sessions={sessions} fetch={fetch} />);
}

/** The tab has settled on what its sign-in reaches: a private board, or the sign-in again. */
const landed = (view: Mounted): boolean =>
  view.text().includes('private client task') || view.text().includes('Your session has ended');

/** A tab opened as one sign-in, once it has landed. */
async function landedTab(...args: Parameters<typeof tab>): Promise<Mounted> {
  const view = await tab(...args);
  await until(view, () => landed(view), 'a board or the sign-in');
  return view;
}

/** The tab shows its own person's private task and never the other's. */
function expectOwnBoard(view: Mounted, own: string, other: string): void {
  expect(view.text()).toContain(`${own} private client task`);
  expect(view.text()).not.toContain(`${other} private client task`);
}

describe('S0-6 isolation', () => {
  it('each person’s tab reads its own client data from a jar holding both named cookies', async () => {
    const firstToken = await tokenFor('first-person');
    const otherToken = await tokenFor('second-person');
    const { api, boards } = serving();
    const cookies = jar(firstToken, otherToken);

    // Control: the fixture reaches the private read, for each person in turn.
    const first = await landedTab(api, cookies, 'first@example.test', firstToken);
    expectOwnBoard(first, 'first-person', 'second-person');
    // The tab still says the first person is signed in: the person menu (C23)
    // names them by email while their name is refused.
    expect(first.find('.appbar .who__trigger')?.getAttribute('aria-label')).toBe(
      'first@example.test, signed in',
    );
    await first.unmount();

    const second = await landedTab(api, cookies, 'second@example.test', otherToken);
    expectOwnBoard(second, 'second-person', 'first-person');
    await second.unmount();

    expect(new Set(boards)).toEqual(new Set(['first-person', 'second-person']));
  });

  it('another person’s cookie cannot show their client data in the first person’s tab', async () => {
    const firstToken = await tokenFor('first-person');
    const otherToken = await tokenFor('second-person');
    const { api, boards } = serving();
    // The first person's cookie is gone; the jar holds only the second's.
    const cookies = jar(otherToken);

    // Control: the same jar, in the second person's tab, reaches their private read.
    const second = await landedTab(api, cookies, 'second@example.test', otherToken);
    expect(second.text()).toContain('second-person private client task');
    await second.unmount();
    expect(boards).toEqual(['second-person']);

    // The first person's tab names its own sign-in, whose cookie is gone: the
    // second person's cookie does not stand in for it, and the tab asks the
    // first person to sign in again.
    const page = await landedTab(api, cookies, 'first@example.test', firstToken);
    expect(page.text()).not.toContain('second-person private client task');
    expect(page.text()).toContain('Your session has ended');
    expect(page.find('.appbar .who__trigger')).toBeNull();
    // No read was answered as the second person for the first person's tab.
    expect(boards).toEqual(['second-person']);
    await page.unmount();
  });
});
