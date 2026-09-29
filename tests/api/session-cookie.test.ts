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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { openSession, signOut } from '../../apps/web/src/session/sign-in.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_PATH,
  SUBJECT_HEADER,
  pathOf,
} from '../../packages/core-wire/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';

const ROOT = join(import.meta.dirname, '../..');
const ISSUER = 'http://127.0.0.1:54391';
const BOARD = `/api/b/alpha${pathOf('task.board')}`;
const CREATE = `/api/b/alpha${pathOf('task.create')}`;
const SAME_ORIGIN = { [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-origin' };

const database = {
  withBusiness: async () => {
    throw new Error('no database in these cases');
  },
} as unknown as Database;

async function bearerFor(subject = 'mia'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
  });
}

function build() {
  const executeRead = vi.fn(async (_db: unknown, _business: string, presented: unknown) => ({
    ok: true as const,
    presented,
  }));
  const executeCommand = vi.fn(async () => ({ recordId: 'r-1', revision: 1 }));
  const api = createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: async (key) =>
      key === 'alpha' || key === 'bravo' ? `business-${key}` : undefined,
    executeRead: executeRead as never,
    executeCommand: executeCommand as never,
  });
  return { api, executeRead, executeCommand };
}

async function post(
  api: ReturnType<typeof createApi>,
  path: string,
  headers: Record<string, string>,
  body: unknown = {},
): Promise<Response> {
  return await api.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The session cookie's value out of a `Set-Cookie`, and its attributes. */
function cookieOf(response: Response): { value: string; attributes: string[] } {
  const header = response.headers.get('set-cookie') ?? '';
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const [name, ...value] = pair.split('=');
  expect(name).toBe(SESSION_COOKIE);
  return { value: value.join('='), attributes: attributes.map((a) => a.toLowerCase()) };
}

const ok = () => new Response('{"ok":true}', { status: 200 });

/** A tab's storage a test can read back whole. */
function memoryStorage(): StorageLike & { readonly all: () => string } {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => held.set(key, value),
    removeItem: (key) => held.delete(key),
    all: () => [...held.values()].join('\n'),
  };
}

describe('S0-6 session cookie', () => {
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
    // Who the cookie is, for the tab to send back: an identifier, not the token.
    expect(JSON.parse(text)).toEqual({ ok: true, subject: 'mia' });
    const cookie = cookieOf(answer);
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
      cookie: `${SESSION_COOKIE}=${token}`,
      [SUBJECT_HEADER]: 'mia',
      ...SAME_ORIGIN,
    });
    expect(answer.status).toBe(200);
    expect(executeRead.mock.calls[0]?.[2]).toEqual({ provider: 'supabase', subject: 'mia' });
  });

  it('signing out clears the cookie', async () => {
    const { api } = build();
    const answer = await post(api, `${SESSION_PATH}/end`, SAME_ORIGIN);
    expect(answer.status).toBe(200);
    const cookie = cookieOf(answer);
    expect(cookie.value).toBe('');
    expect(cookie.attributes).toEqual(expect.arrayContaining(['max-age=0', 'path=/api/b/']));
  });

  it('a signed-in page holds no readable token: not in the session, not in tab storage', async () => {
    const token = await bearerFor();
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes('/token?') ? { access_token: token } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await openSession({
      gotrueUrl: ISSUER,
      apiOrigin: '',
      email: 'mia@example.test',
      password: 'pw',
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

  it('a slow sign-out never brings back a person who has signed out since', async () => {
    let cookie: string | null = 'a';
    const written: (string | null)[] = [];
    const held: (() => void)[] = [];
    const tokens = ['b', 'c'];
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
      openSession({ ...route, gotrueUrl: ISSUER, email, password: 'pw' });

    void signOut(route);
    await signInAs('b@example.test');
    await signOut(route);
    await signInAs('c@example.test');
    expect(cookie).toBe('c');
    written.length = 0;
    held[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cookie).toBe('c');
    // Only C's sign-in wrote again: B, who signed out, never came back.
    expect(written).toEqual(['c']);
  });

  it('signing out asks the API to clear the cookie', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await signOut({ apiOrigin: '', fetch });
    expect(urls).toEqual([`${SESSION_PATH}/end`]);
  });
});

describe('S0-6 csrf', () => {
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

  it('the browser client sends the header on every call and never a bearer', async () => {
    const headers: Record<string, string>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{"ok":true}', { status: 200 });
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
});

/** A tab that signed in as `tab`, in a browser whose cookie is now `cookie`'s. */
async function fromTab(tab: string | undefined, cookie: string, path = BOARD) {
  const { api, executeRead } = build();
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE}=${await bearerFor(cookie)}`,
    ...SAME_ORIGIN,
  };
  if (tab !== undefined) headers[SUBJECT_HEADER] = tab;
  const answer = await post(api, path, headers);
  return { answer, executeRead };
}

describe('S0-6 isolation: one cookie, many tabs', () => {
  it('person crossover: a tab signed in as ada reads nothing on mia’s cookie', async () => {
    const other = await fromTab('ada', 'mia');
    expect(other.answer.status).toBe(403);
    expect(await other.answer.json()).toMatchObject({ code: 'AUTH_SESSION_MISMATCH' });
    expect(other.executeRead).not.toHaveBeenCalled();
    const own = await fromTab('ada', 'ada');
    expect(own.answer.status).toBe(200);
  });

  it('client crossover: a client contact’s tab and a member’s tab never read on each other’s cookie', async () => {
    const crossed = await Promise.all([
      fromTab('client-contact-of-alpha', 'alpha-member'),
      fromTab('alpha-member', 'client-contact-of-alpha'),
    ]);
    for (const { answer, executeRead } of crossed) {
      expect(answer.status).toBe(403);
      expect(executeRead).not.toHaveBeenCalled();
    }
  });

  it('business crossover: the cookie names no business; the path does, and login resolution decides', async () => {
    const bravo = await fromTab('mia', 'mia', `/api/b/bravo${pathOf('task.board')}`);
    expect(bravo.answer.status).toBe(200);
    expect(bravo.executeRead.mock.calls[0]?.[1]).toBe('business-bravo');
    const nowhere = await fromTab('mia', 'mia', `/api/b/charlie${pathOf('task.board')}`);
    expect(nowhere.answer.status).toBe(403);
    expect(await nowhere.answer.json()).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
    expect(nowhere.executeRead).not.toHaveBeenCalled();
  });

  it('a tab that kept a session from before it knew its person is refused, not trusted', async () => {
    const unnamed = await fromTab(undefined, 'mia');
    expect(unnamed.answer.status).toBe(403);
    expect(unnamed.executeRead).not.toHaveBeenCalled();
  });

  it('the browser client names its tab’s person on every call', async () => {
    const sent: Record<string, string>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      subject: 'mia',
      fetch,
    });
    await client.read('task.board', {});
    await client.mutate('task.create', { title: 'x' });
    expect(sent.map((headers) => headers[SUBJECT_HEADER])).toEqual(['mia', 'mia']);
  });
});

describe('S0-6 content policy', () => {
  const page = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="(?<policy>[^"]+)"/iu.exec(
    page,
  );
  const policy = meta?.groups?.['policy'] ?? '';
  const directive = (name: string) =>
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/u))
      .find(([key]) => key === name)
      ?.slice(1);

  it('the page carries a policy, ahead of every script, that runs only its own scripts', () => {
    expect(meta).not.toBeNull();
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script'));
    // Only same-origin files: no inline script, no eval, no other host.
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|nonce-|sha256-|\*/u);
  });

  it('the page itself has no inline script for the policy to have to allow', () => {
    const scripts = [
      ...page.matchAll(/<script\b(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/giu),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.groups?.['attributes']).toMatch(/\ssrc="\/[^/]/u);
      expect(script.groups?.['body']?.trim()).toBe('');
    }
  });
});
