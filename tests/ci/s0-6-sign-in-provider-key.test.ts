// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6 sign-in on hosted Supabase (STAGING-PREP B11, B13). The hosted sign-in
// service refuses any request without the project's publishable key in an
// `apikey` header ("No API key found in request", read on staging's project
// 1 Oct 2026). The key is public and differs per project, so, like the sign-in
// address (G3), the page reads it at run time from `GET /api/sign-in`, set on
// the function as `SUPABASE_PUBLISHABLE_KEY`, and sends it only to the sign-in
// service, never to the API.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { withProviderKey } from '../../apps/web/src/session/provider-key.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

const HOST = 'ops.example.test';
const KEY_ID = 'test/provider-key@1';
const PUBLISHABLE = 'sb_publishable_example-test-only';

const handler = (extra: Record<string, string>) =>
  createFunctionHandler({
    SERVED_HOST: HOST,
    DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/none',
    DATABASE_LOOKUP_URL: 'postgres://app:unused@127.0.0.1:1/none',
    GOTRUE_URL: TEST_ISSUER,
    DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
    DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
    ...extra,
  });

const askSignIn = async (extra: Record<string, string>): Promise<unknown> => {
  const answer = await handler(extra)(
    new Request(`https://${HOST}/api/sign-in`, { headers: { host: HOST } }),
  );
  expect(answer.status).toBe(200);
  return await answer.json();
};

describe('S0-6 sign-in on hosted Supabase: the page learns the publishable key at run time', () => {
  it('the API hands the page the publishable key beside the sign-in address', async () => {
    expect(await askSignIn({ SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE })).toStrictEqual({
      issuer: TEST_ISSUER,
      key: PUBLISHABLE,
    });
  });

  it('with no key set (local sign-in needs none) the answer names none', async () => {
    expect(await askSignIn({})).toStrictEqual({ issuer: TEST_ISSUER });
  });
});

/** A made-up project, built here so no reference-shaped literal sits in the file. */
const PROJECT = 'abcdefghij'.repeat(2);
const issuer = `https://${PROJECT}.supabase.co/auth/v1`;
const seen = (): { calls: [string, Headers][]; fetch: typeof fetch } => {
  const calls: [string, Headers][] = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), new Headers(init?.headers)]);
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  return { calls, fetch: fetcher };
};

/** A key of the given kind, built here so no key-shaped literal sits in the file. */
const legacyKey = (role: string): string =>
  ['{"alg":"HS256","typ":"JWT"}', JSON.stringify({ iss: 'supabase', role })]
    .map((part) => Buffer.from(part).toString('base64url'))
    .concat('signature')
    .join('.');

describe('S0-6 sign-in on hosted Supabase: only a publishable key is ever handed out', () => {
  it('refuses to start with a secret key in the publishable key setting, naming the setting only', () => {
    const secret = ['sb', 'secret', 'example-test-only'].join('_');
    for (const key of [secret, legacyKey('service_role'), 'not-a-key']) {
      expect(() => handler({ SUPABASE_PUBLISHABLE_KEY: key })).toThrow(
        'SUPABASE_PUBLISHABLE_KEY is not a publishable key',
      );
      try {
        handler({ SUPABASE_PUBLISHABLE_KEY: key });
      } catch (error) {
        expect(String(error)).not.toContain(key);
      }
    }
  });

  it('starts with a publishable key or a legacy anon key', async () => {
    expect(await askSignIn({ SUPABASE_PUBLISHABLE_KEY: legacyKey('anon') })).toStrictEqual({
      issuer: TEST_ISSUER,
      key: legacyKey('anon'),
    });
  });
});

describe('S0-6 sign-in on hosted Supabase: the key goes to the sign-in service only', () => {
  it('adds the key to a call to the sign-in service, keeping its own headers', async () => {
    const { calls, fetch } = seen();
    await withProviderKey(
      fetch,
      issuer,
      PUBLISHABLE,
    )(`${issuer}/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(calls[0]?.[1].get('apikey')).toBe(PUBLISHABLE);
    expect(calls[0]?.[1].get('content-type')).toBe('application/json');
  });

  it('keeps the headers a Request carries, and never follows a redirect with the key', async () => {
    const { calls, fetch } = seen();
    let redirect: RequestRedirect | undefined;
    const watched = ((input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return fetch(input, init);
    }) as typeof fetch;
    await withProviderKey(
      watched,
      issuer,
      PUBLISHABLE,
    )(new Request(`${issuer}/token`, { headers: { 'content-type': 'application/json' } }));
    expect(calls[0]?.[1].get('content-type')).toBe('application/json');
    expect(calls[0]?.[1].get('apikey')).toBe(PUBLISHABLE);
    expect(redirect).toBe('error');
  });

  it('never sends the key to the API or to a look-alike address', async () => {
    const { calls, fetch } = seen();
    const keyed = withProviderKey(fetch, issuer, PUBLISHABLE);
    await keyed('/api/session', { headers: { authorization: 'Bearer x' } });
    await keyed(`${issuer}.example.test/token`);
    await keyed(`https://${PROJECT}.supabase.co/auth/v10/token`);
    expect(calls.map(([, headers]) => headers.get('apikey'))).toEqual([null, null, null]);
  });

  it('with no key set the fetch is handed back unchanged', () => {
    const { fetch } = seen();
    expect(withProviderKey(fetch, issuer, '')).toBe(fetch);
  });
});
