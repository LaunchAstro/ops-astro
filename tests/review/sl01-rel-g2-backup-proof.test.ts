// SPDX-License-Identifier: AGPL-3.0-only
// Narrow re-check proof: the Vercel entry must reject backup logins.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { GET } from '../../apps/api/function.ts';

it('G2 function refuses a backup credential in its runtime environment', async () => {
  const saved = { ...process.env };
  const keyId = 'test/rel-backup@1';
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/none',
    DATABASE_LOOKUP_URL: 'postgres://lookup:unused@127.0.0.1:1/none',
    GOTRUE_URL: 'http://127.0.0.1:54391',
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
    BACKUP_SOURCE_URL: 'postgres://backup:unused@127.0.0.1:1/none',
  });
  try {
    await expect(
      GET(
        new Request('https://ops.example.test/api/health', {
          headers: { host: 'ops.example.test' },
        }),
      ),
    ).rejects.toThrow('BACKUP_SOURCE_URL');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
