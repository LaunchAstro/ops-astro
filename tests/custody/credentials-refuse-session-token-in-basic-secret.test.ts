// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { parseCredentials } from '../../packages/core-custody/src/credentials.ts';

it('a sess token in a Basic secret is refused before storage', () => {
  const parsed = parseCredentials([
    {
      ref: 'auth_key',
      kind: 'api_key',
      account: 'synthetic-auth-account',
      destination: 'auth_target',
      header: 'authorization',
      scheme: 'basic',
      value: 'person:sess-synthetic-session-only',
    },
  ]);
  expect(parsed.ok ? 'loaded' : parsed.code).toBe('SESSION_TOKEN_REFUSED');
});

/** An encrypted token in compact form: five base64url parts, the first naming its encryption. */
const ENCRYPTED = [
  Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString('base64url'),
  '',
  'c3ludGhldGlj',
  'c2Vzc2lvbg',
  'dGFn',
].join('.');

it.each([
  ['a cookie pair', 'auth=1;sess-synthetic-session-only'],
  ['a cookie value', 'token=sess-synthetic-session-only'],
  ['a query pair', 'a=1&sess-synthetic-session-only'],
  ['a Basic secret after a zero-width space', 'person:\u200Bsess-synthetic-session-only'],
  [
    'a Basic pair encoded alone',
    Buffer.from('person:sess-synthetic-session-only').toString('base64'),
  ],
  ['a Basic secret holding an encrypted token', `person:${ENCRYPTED}`],
  ['quotes around an encrypted token', `"${ENCRYPTED}"`],
  ['a Basic secret with a space before it', 'person: sess-synthetic-session-only'],
] as const)('a session token in %s is refused before storage', (_case, value) => {
  const parsed = parseCredentials([
    {
      ref: 'auth_key',
      kind: 'api_key',
      account: 'synthetic-auth-account',
      destination: 'auth_target',
      header: 'authorization',
      value,
    },
  ]);
  expect(parsed.ok ? 'loaded' : parsed.code).toBe('SESSION_TOKEN_REFUSED');
});

it('a key holding sess- inside one token is stored', () => {
  const parsed = parseCredentials([
    {
      ref: 'auth_key',
      kind: 'api_key',
      account: 'synthetic-auth-account',
      destination: 'auth_target',
      header: 'authorization',
      value: 'synthetic-key-possess-0123456789',
    },
  ]);
  expect(parsed.ok).toBe(true);
});
