// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-6c session suites' shared helpers (session-cookie*.test.ts): the API
// over stub executors, a bearer from the fixture key set, and cookie and
// storage readers.

import { join } from 'node:path';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { type StorageLike } from '../../apps/web/src/session/token.ts';
import { CSRF_HEADER, pathOf } from '../../packages/core-wire/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { signBearer, TEST_ISSUER } from '../support/sign-in.ts';

export const ROOT: string = join(import.meta.dirname, '../..');

export const ISSUER: string = TEST_ISSUER;

export const BOARD: string = `/api/b/alpha${pathOf('task.board')}`;

export const CREATE: string = `/api/b/alpha${pathOf('task.create')}`;

export const SAME_ORIGIN: Record<string, string> = {
  [CSRF_HEADER]: '1',
  'sec-fetch-site': 'same-origin',
};

export const database = {
  withBusiness: async () => {
    throw new Error('no database in these cases');
  },
} as unknown as Database;

export async function bearerFor(subject = 'mia', jti?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    ...(jti === undefined ? {} : { jti }),
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
  });
}

export async function post(
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
export function cookieOf(response: Response): {
  name: string;
  value: string;
  attributes: string[];
} {
  const header = response.headers.get('set-cookie') ?? '';
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const [name, ...value] = pair.split('=');
  return {
    name: name ?? '',
    value: value.join('='),
    attributes: attributes.map((a) => a.toLowerCase()),
  };
}

export const ok = (): Response => new Response('{"ok":true}', { status: 200 });

/** A tab's storage a test can read back whole. */
export function memoryStorage(): StorageLike & { readonly all: () => string } {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => held.set(key, value),
    removeItem: (key) => held.delete(key),
    all: () => [...held.values()].join('\n'),
  };
}

/** One sign-in: its token and the id the API gives its tab. */
export async function signInOf(
  who: string,
  jti?: string,
): Promise<{ token: string; id: string; cookie: string }> {
  const token = await bearerFor(who, jti);
  return { token, id: sessionIdOf(token), cookie: `${cookieNameFor(sessionIdOf(token))}=${token}` };
}
