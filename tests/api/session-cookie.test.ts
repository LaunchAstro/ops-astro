// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6c: the browser's session lives in a cookie the API sets, every request
// that cookie carries passes a CSRF check, and the pages refuse inline and
// outside scripts.
//
// `S0-6 session cookie` is the invariant: a signed-in page holds no readable
// token. It is red until the API issues the cookie on an ES256 token S0-6b's
// verifier accepts, and red again if the token returns to tab storage.
// `S0-6 csrf` and `S0-6 content policy` are the two rows beside it.
//
// Nothing here needs the network or a database: the key set is the static
// fixture one and the executors are stubs that say who they were called for.

import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { openSession, signOut } from '../../apps/web/src/session/sign-in.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_PATH,
  SESSION_HEADER,
} from '../../packages/core-wire/src/index.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  ISSUER,
  BOARD,
  CREATE,
  SAME_ORIGIN,
  database,
  bearerFor,
  post,
  cookieOf,
  ok,
  memoryStorage,
} from './session-cookie.fixture.ts';

function build() {
  const executeRead = vi.fn((_db: unknown, _business: string, presented: unknown) =>
    Promise.resolve({
      ok: true as const,
      presented,
    }),
  );
  const executeCommand = vi.fn(() => Promise.resolve({ recordId: 'r-1', revision: 1 }));
  const api = createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: (key) =>
      Promise.resolve(key === 'alpha' || key === 'bravo' ? `business-${key}` : undefined),
    executeRead: executeRead as never,
    executeCommand: executeCommand as never,
  });
  return { api, executeRead, executeCommand };
}

describe('S0-6 session cookie', () => {
  sessionCookieCases1();
  sessionCookieCases2();
  sessionCookieCases3();
  sessionCookieCases4();
});

describe('S0-6 csrf', () => {
  csrfCases1();
  csrfCases2();
});

function sessionCookieCases1() {
  it('the API trades a verified ES256 token for a Secure, HttpOnly, SameSite=Lax cookie', async () => {
    const { api } = build();
    const token = await bearerFor();
    const answer = await post(api, SESSION_PATH, {
      authorization: `Bearer ${token}`,
      ...SAME_ORIGIN,
    });

    expect(answer.status).toBe(200);
    // The answer a page can read says nothing about the credential.
    const text = await answer.text();
    expect(text).not.toContain(token);
    // This sign-in's id, for the tab to send back: a digest, not the token.
    expect(JSON.parse(text)).toEqual({ ok: true, session: sessionIdOf(token) });
    const cookie = cookieOf(answer);
    // One cookie per sign-in, named from that id.
    expect(cookie.name).toBe(cookieNameFor(sessionIdOf(token)));
    expect(cookie.value).toBe(token);
    expect(cookie.attributes).toEqual(
      expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/api/b/']),
    );
  });

  it('a token the published keys do not verify gets no cookie', async () => {
    const { api } = build();
    const answer = await post(api, SESSION_PATH, {
      authorization: 'Bearer not.a.token',
      ...SAME_ORIGIN,
    });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('set-cookie')).toBeNull();
  });

  it('the cookie alone signs a browser request in, as the token it holds', async () => {
    const { api, executeRead } = build();
    const token = await bearerFor('mia');
    const answer = await post(api, BOARD, {
      cookie: `${cookieNameFor(sessionIdOf(token))}=${token}`,
      [SESSION_HEADER]: sessionIdOf(token),
      ...SAME_ORIGIN,
    });
    expect(answer.status).toBe(200);
    expect(executeRead.mock.calls[0]?.[2]).toEqual({ provider: 'supabase', subject: 'mia' });
  });
}

function sessionCookieCases2() {
  it('signing out clears the named sign-in’s cookie; naming none, or no id this API issues, clears none', async () => {
    const { api } = build();
    const unnamed = await post(api, `${SESSION_PATH}/end`, SAME_ORIGIN);
    expect(unnamed.headers.get('set-cookie')).toBeNull();
    const forged = await post(api, `${SESSION_PATH}/end`, {
      [SESSION_HEADER]: 'x; Path=/; Domain=example.test',
      ...SAME_ORIGIN,
    });
    expect(forged.headers.get('set-cookie')).toBeNull();
    const id = sessionIdOf(await bearerFor());
    const answer = await post(api, `${SESSION_PATH}/end`, { [SESSION_HEADER]: id, ...SAME_ORIGIN });
    expect(answer.status).toBe(200);
    const cookie = cookieOf(answer);
    expect(cookie.name).toBe(cookieNameFor(id));
    expect(cookie.value).toBe('');
    expect(cookie.attributes).toEqual(expect.arrayContaining(['max-age=0', 'path=/api/b/']));
  });

  it('a signed-in page holds no readable token: not in the session, not in tab storage', async () => {
    const token = await bearerFor();
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes('/token?') ? { access_token: token } : { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const result = await openSession({
      gotrueUrl: ISSUER,
      apiOrigin: '',
      email: 'mia@example.test',
      password: 'ops-astro-test-only-pw',
      fetch,
    });
    expect(result).toEqual({ ok: true });
    // The token went to the API once, as the bearer the cookie is made from.
    expect(sent[1]?.url).toBe(SESSION_PATH);
    expect(sent[1]?.headers['authorization']).toBe(`Bearer ${token}`);

    const storage = memoryStorage();
    const store = new SessionStore(storage);
    store.set({ businessKey: 'alpha', email: 'mia@example.test' });
    expect(JSON.stringify(store.session)).not.toContain(token);
    expect(storage.all()).not.toContain(token);
    expect(storage.all()).not.toMatch(/token/iu);
  });
}

function sessionCookieCases3() {
  it('a slow sign-out never brings back a person who has signed out since', async () => {
    let cookie: string | null = 'a';
    const written: (string | null)[] = [];
    const held: (() => void)[] = [];
    const tokens = ['ops-astro-test-only-b', 'ops-astro-test-only-c'];
    const fetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes('/token?')) {
        return new Response(JSON.stringify({ access_token: tokens.shift() }), { status: 200 });
      }
      if (url === SESSION_PATH) {
        cookie = headers['authorization']?.replace('Bearer ', '') ?? null;
        written.push(cookie);
        return ok();
      }
      // The first sign-out is slow; the rest answer at once.
      if (held.length === 0 && cookie === 'a') {
        return await new Promise<Response>((resolve) => {
          held.push(() => {
            cookie = null;
            resolve(ok());
          });
        });
      }
      cookie = null;
      return ok();
    }) as unknown as typeof globalThis.fetch;
    const route = { apiOrigin: '', fetch };
    const signInAs = (email: string) =>
      openSession({ ...route, gotrueUrl: ISSUER, email, password: 'ops-astro-test-only-pw' });

    void signOut(route);
    await signInAs('b@example.test');
    await signOut(route);
    await signInAs('c@example.test');
    expect(cookie).toBe('ops-astro-test-only-c');
    written.length = 0;
    held[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cookie).toBe('ops-astro-test-only-c');
    // Only C's sign-in wrote again: B, who signed out, never came back.
    expect(written).toEqual(['ops-astro-test-only-c']);
  });
}

function sessionCookieCases4() {
  it('signing out asks the API to clear the cookie', async () => {
    const urls: string[] = [];
    const fetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await signOut({ apiOrigin: '', fetch });
    expect(urls).toEqual([`${SESSION_PATH}/end`]);
  });
}

function csrfCases1() {
  it('a cookie-carried request without the same-origin header is refused before anything runs', async () => {
    const { api, executeCommand } = build();
    const token = await bearerFor();
    const answer = await post(
      api,
      CREATE,
      { cookie: `${SESSION_COOKIE}=${token}` },
      { title: 'x' },
    );
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ refused: true, code: 'AUTH_CROSS_SITE' });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('a request the browser marks cross-site is refused even with the header', async () => {
    const { api, executeCommand } = build();
    const token = await bearerFor();
    const answer = await post(
      api,
      CREATE,
      { cookie: `${SESSION_COOKIE}=${token}`, [CSRF_HEADER]: '1', 'sec-fetch-site': 'cross-site' },
      { title: 'x' },
    );
    expect(answer.status).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('the session exchange is refused cross-site, so no page can sign a person in as someone else', async () => {
    const { api } = build();
    const token = await bearerFor();
    const answer = await post(api, SESSION_PATH, { authorization: `Bearer ${token}` });
    expect(answer.status).toBe(403);
    expect(answer.headers.get('set-cookie')).toBeNull();
  });

  it('the command line keeps its bearer token and needs no browser header', async () => {
    const { api, executeCommand } = build();
    const token = await bearerFor();
    const answer = await post(api, CREATE, { authorization: `Bearer ${token}` }, { title: 'x' });
    expect(answer.status).toBe(200);
    expect(executeCommand).toHaveBeenCalledOnce();
  });
}

function csrfCases2() {
  it('the browser client sends the header on every call and never a bearer', async () => {
    const headers: Record<string, string>[] = [];
    const fetch = ((_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    await client.read('task.board', {});
    await client.mutate('task.create', { title: 'x' });
    expect(headers).toHaveLength(2);
    for (const sent of headers) {
      expect(sent[CSRF_HEADER]).toBe('1');
      expect(sent['authorization']).toBeUndefined();
    }
  });
}
