// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { parseCredentials } from '../../packages/core-custody/src/credentials.ts';

it('Sol proof, criterion 3: a sess token in a Basic secret is refused before storage', () => {
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
