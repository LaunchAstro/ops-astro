// SPDX-License-Identifier: AGPL-3.0-only
//
// The password grant against GoTrue, and nothing else: the one sign-in the
// browser (`sign-in.ts`), the command line's `login` and the worker
// (`apps/worker/sign-in.ts`) all make. It posts the credentials to the identity
// provider's own endpoint and keeps whatever token comes back; the API verifies
// the signature. It imports nothing, so the worker can make it without loading
// the browser's client of the API.

export interface SignInRequest {
  readonly gotrueUrl: string;
  readonly email: string;
  readonly password: string;
  readonly fetch: typeof globalThis.fetch;
}

export type SignInResult =
  | {
      readonly ok: true;
      readonly token: string;
      /** GoTrue's `expires_in`, the token's life in seconds, when it gave one. */
      readonly expiresIn?: number;
    }
  | { readonly ok: false; readonly because: string };

export async function signIn(request: SignInRequest): Promise<SignInResult> {
  const url = `${request.gotrueUrl.replace(/\/$/u, '')}/token?grant_type=password`;
  let response: Response;
  try {
    response = await request.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: request.email, password: request.password }),
    });
  } catch {
    return { ok: false, because: 'The sign-in service did not answer.' };
  }

  const parsed: unknown = await response.json().catch(() => {});
  if (!response.ok) {
    // GoTrue's own words where it gave some, and the status where it did not.
    // No attempt to guess whether the email or the password was the wrong one:
    // that distinction is an account-enumeration channel.
    return {
      ok: false,
      because: messageOf(parsed) ?? `Sign-in failed (${String(response.status)}).`,
    };
  }
  const token = tokenOf(parsed);
  if (token === null)
    return { ok: false, because: 'Sign-in succeeded and returned no access token.' };
  const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
  return typeof expiresIn === 'number' && expiresIn > 0
    ? { ok: true, token, expiresIn }
    : { ok: true, token };
}

function tokenOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  const token = body['access_token'];
  return typeof token === 'string' && token !== '' ? token : null;
}

function messageOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  for (const key of ['error_description', 'msg', 'message', 'error']) {
    const said = body[key];
    if (typeof said === 'string' && said !== '') return said;
  }
  return null;
}
