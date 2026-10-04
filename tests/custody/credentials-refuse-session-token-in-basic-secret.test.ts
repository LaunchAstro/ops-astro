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

it.each([
  ['a cookie pair', 'auth=1; sess-synthetic-session-only'],
  ['a Basic secret with a space before it', 'person: sess-synthetic-session-only'],
] as const)('a sess token in %s is refused before storage', (_case, value) => {
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
