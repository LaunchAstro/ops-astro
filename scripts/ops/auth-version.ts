// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in server's version, as the web deploy records it (web-deploy.ts,
// `S0-6 image pins`): read from `/health` under GOTRUE_URL with no redirect, a
// time limit and a size cap, and its shape checked.

type Environment = Readonly<Record<string, string | undefined>>;

/** Staging's sign-in address; a loopback stand-in in tests. */
const SIGN_IN =
  /^(?:https:\/\/[a-z]{20}\.supabase\.co|http:\/\/127\.0\.0\.1:[0-9]{1,5})\/auth\/v1$/u;
const AUTH_VERSION = /^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}[0-9A-Za-z.+-]{0,40}$/u;
const HEALTH_MAX_BYTES = 4096;

/** The version the sign-in server reports: no redirect, a time limit, a size cap, its shape checked. */
export async function authVersionOf(env: Environment): Promise<string | undefined> {
  const address = env['GOTRUE_URL'] ?? '';
  if (!SIGN_IN.test(address)) return undefined;
  const key = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  try {
    const response = await fetch(`${address}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: key === '' ? {} : { apikey: key },
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > HEALTH_MAX_BYTES)
      return undefined;
    const body = await response.arrayBuffer();
    if (body.byteLength > HEALTH_MAX_BYTES) return undefined;
    const { version } = JSON.parse(new TextDecoder().decode(body)) as { version?: unknown };
    return typeof version === 'string' && AUTH_VERSION.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
