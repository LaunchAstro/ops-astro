// SPDX-License-Identifier: AGPL-3.0-only
//
// The password grant against GoTrue: the one sign-in the browser
// (`sign-in.ts`), the command line's `login` and the worker
// (`apps/worker/sign-in.ts`) all make. It posts the credentials to the identity
// provider's own endpoint and keeps whatever token comes back; the API verifies
// the signature. Beside it, the one other call a person makes there: setting
// their own new password (`password-change.ts`). It imports nothing, so the
// worker can make it without loading the browser's client of the API.

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
  const body = { email: request.email, password: request.password };
  const response = await toProvider(request, '/token?grant_type=password', 'POST', body);
  if (response === undefined) return { ok: false, because: 'The sign-in service did not answer.' };

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

export type PasswordSet = 'set' | 'needs-code' | { readonly because: string };

/**
 * The person's own new password, set at GoTrue (`PUT /user`) with a token of theirs. A login
 * with an authenticator app is refused there below `aal2` (`insufficient_aal`): `needs-code`.
 */
export async function setPassword(request: {
  readonly gotrueUrl: string;
  readonly token: string;
  readonly password: string;
  readonly fetch: typeof globalThis.fetch;
}): Promise<PasswordSet> {
  const response = await toProvider(
    request,
    '/user',
    'PUT',
    { password: request.password },
    { authorization: `Bearer ${request.token}` },
    // A redirect is refused, never followed: the password goes to the sign-in service alone.
    'error',
  );
  if (response === undefined) return { because: 'The sign-in service did not answer.' };
  if (response.ok) return 'set';
  const parsed: unknown = await response.json().catch(() => {});
  if ((parsed as { error_code?: unknown } | undefined)?.error_code === 'insufficient_aal') {
    return 'needs-code';
  }
  return {
    because: messageOf(parsed) ?? `The password was not changed (${String(response.status)}).`,
  };
}

/** One JSON call to the sign-in service, or undefined when it did not answer. */
async function toProvider(
  request: { readonly gotrueUrl: string; readonly fetch: typeof globalThis.fetch },
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  redirect?: RequestRedirect,
): Promise<Response | undefined> {
  const url = `${request.gotrueUrl.replace(/\/$/u, '')}${path}`;
  try {
    return await request.fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(redirect === undefined ? {} : { redirect }),
    });
  } catch {
    return undefined;
  }
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
