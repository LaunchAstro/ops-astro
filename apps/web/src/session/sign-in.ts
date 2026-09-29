// SPDX-License-Identifier: AGPL-3.0-only
//
// Sign-in: a password grant against GoTrue, and nothing else.
//
// The application never mints, signs or inspects a token. It posts the
// credentials to the identity provider's own endpoint and keeps whatever comes
// back; the API verifies the signature. That is what "local test credentials
// must use its normal verification entry" means in the acceptance checklist —
// a development bypass that accepted an actor header would prove nothing about
// the production path (N7).
//
// The business key a person chooses here is a *routing* choice, not a claim.
// It selects which `/api/b/:businessKey` prefix the client calls. The server
// resolves the token's subject to a login in that business and refuses when
// there is none, so choosing `bravo` with an alpha-only account does not get
// anybody into bravo — it gets them `AUTH_NO_MEMBERSHIP`.

import {
  CSRF_HEADER,
  SESSION_PATH,
  SUBJECT_HEADER,
} from '../../../../packages/core-wire/src/index.ts';

export interface SignInRequest {
  readonly gotrueUrl: string;
  readonly email: string;
  readonly password: string;
  readonly fetch: typeof globalThis.fetch;
}

export type SignInResult =
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly because: string };

/** Where the API is served from: empty for the page's own origin. */
export interface ApiRoute {
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

/** Sign-outs still on their way to the API, and a count of sign-ins and outs. */
const signingOut = new Set<Promise<unknown>>();
let latest = 0;

/**
 * The browser's sign-in: the password grant, then the token straight to the
 * API, which keeps it as an `HttpOnly` session cookie no script reads (S0-6c).
 * What comes back is the person the cookie is, as the API names them, never
 * the token. The command line calls `signIn` and keeps its bearer instead.
 */
export async function openSession(
  request: SignInRequest & ApiRoute,
): Promise<
  | { readonly ok: true; readonly subject?: string }
  | { readonly ok: false; readonly because: string }
> {
  const result = await signIn(request);
  if (!result.ok) return result;
  const bearer = `Bearer ${result.token}`;
  const mine = ++latest;
  // A sign-out still in flight clears whichever cookie is there when its
  // answer lands, this one included. So once it has landed the session is
  // written again, unless a later sign-in or sign-out has had its say.
  if (signingOut.size > 0) {
    const landed = Promise.allSettled(signingOut);
    void (async () => {
      await landed;
      if (latest === mine) await toApi(request, SESSION_PATH, { authorization: bearer });
    })();
  }
  const answer = await toApi(request, SESSION_PATH, { authorization: bearer });
  if (answer === undefined) return { ok: false, because: 'The API did not accept the sign-in.' };
  const body: unknown = await answer.json().catch(() => undefined);
  const subject = (body as { subject?: unknown } | undefined)?.subject;
  return typeof subject === 'string' ? { ok: true, subject } : { ok: true };
}

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

  const parsed: unknown = await response.json().catch(() => undefined);
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
  return token === null
    ? { ok: false, because: 'Sign-in succeeded and returned no access token.' }
    : { ok: true, token };
}

/** Ask the API to clear this person's session cookie. The page cannot. */
export async function signOut(request: ApiRoute & { readonly subject?: string }): Promise<void> {
  latest += 1;
  const named = request.subject === undefined ? {} : { [SUBJECT_HEADER]: request.subject };
  const sent = toApi(request, `${SESSION_PATH}/end`, named);
  signingOut.add(sent);
  await sent;
  signingOut.delete(sent);
}

/** One call to the session route, with the header its CSRF check asks for. */
async function toApi(
  request: ApiRoute,
  path: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<Response | undefined> {
  const headers = { ...extra, [CSRF_HEADER]: '1' };
  try {
    const response = await request.fetch(`${request.apiOrigin}${path}`, {
      method: 'POST',
      headers,
    });
    return response.ok ? response : undefined;
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
