// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's provider calls for an ended login, and the admin key they carry
// (ORCH44 21:13Z, ORCH46, ORCH47). The key lives only where the endings loop
// runs (`apps/endings`) and, on a local stack, in the local server; the Vercel
// function never holds it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'hono/jwt';
import type { LoginProvider, ProviderAnswer } from '../../../packages/core-commands/src/index.ts';
import { createGoTrueLogins } from './logins.ts';

/** A local GoTrue: the only issuer a key minted from the checkout's own may reach. */
const LOOPBACK_ISSUER = /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/u;

/**
 * C58's admin key (ORCH44 21:13Z): `SUPABASE_SERVICE_KEY`, batch 1's admin
 * credential (hosted, the project's service key), for an `https` or loopback
 * issuer only. On a local stack with none
 * set, a five-minute `service_role` bearer signed with the local auth key in
 * `localDirectory`, minted per call, as the seed tools make it. Otherwise none.
 */
export function providerAdminKey(
  environment: Readonly<Record<string, string | undefined>>,
  localDirectory: string,
): (() => Promise<string>) | undefined {
  const issuer = environment['GOTRUE_URL'] ?? '';
  const loopback = LOOPBACK_ISSUER.test(issuer);
  const key = environment['SUPABASE_SERVICE_KEY'] ?? '';
  // Never in clear text: a hosted issuer is reached over TLS or not at all.
  if (key !== '')
    return loopback || issuer.startsWith('https://') ? () => Promise.resolve(key) : undefined;
  const file = join(localDirectory, 'auth-signing-key.json');
  if (!loopback || !existsSync(file)) return undefined;
  return async () => {
    const [jwk, ...others] = JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey[];
    if (jwk === undefined || others.length > 0) throw new Error('the local key is not one key');
    const now = Math.floor(Date.now() / 1000);
    const claims = { role: 'service_role', aud: 'authenticated', iat: now, exp: now + 300 };
    return await sign({ ...claims, iss: 'ops-astro-local-api' }, jwk, 'ES256');
  };
}

/** A provider call not sent: the step stays owed. */
const notSent = async (): Promise<ProviderAnswer<void>> =>
  await Promise.resolve({ ok: false, fault: 'unreachable' });

/** GoTrue's calls for an ended login, under the admin key; with none, nothing is sent. */
export function goTrueLogins(
  adminKey: (() => Promise<string>) | undefined,
  issuer: string,
): LoginProvider {
  if (adminKey === undefined) return { endSessions: notSent, deactivate: notSent };
  return createGoTrueLogins({ baseUrl: issuer, adminKey });
}
