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

import { isRefusal, OperationsClient } from '../operations/client.ts';
import { signIn, type SignInRequest } from './password-grant.ts';
import {
  CSRF_HEADER,
  PREFIX,
  SESSION_HEADER,
  SESSION_PATH,
} from '../../../../packages/core-wire/src/index.ts';

export { signIn, type SignInRequest, type SignInResult } from './password-grant.ts';

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
  | { readonly ok: true; readonly sessionId?: string }
  | { readonly ok: false; readonly because: string }
> {
  const result = await signIn(request);
  if (!result.ok) return result;
  const bearer = `Bearer ${result.token}`;
  const mine = ++latest;
  // A sign-out still in flight that names no session may clear this one when
  // it lands, so once it has the session is written again, unless a later
  // sign-in or sign-out has had its say.
  if (signingOut.size > 0) {
    const landed = Promise.allSettled(signingOut);
    void (async () => {
      await landed;
      if (latest === mine) await toApi(request, SESSION_PATH, { authorization: bearer });
    })();
  }
  return await tradeForCookie(request, result.token);
}

/** A password sign-in the API serves only after its second factor: its client and cookie id. */
export interface AskedForCode {
  readonly client: OperationsClient;
  readonly sessionId?: string;
}

/**
 * The browser's sign-in, then one read on its new cookie in the chosen business: an extra
 * round trip. A login with a verified authenticator app is refused
 * `AUTH_SECOND_FACTOR_REQUIRED` below `aal2` (C59), and then the sign-in is not open yet:
 * `asked` carries what its code step needs. Any other answer opens it as before; the API,
 * not this read, refuses whatever it refuses.
 */
export async function openSignIn(
  request: SignInRequest &
    ApiRoute & {
      readonly businessKey: string;
      /** Told the cookie's id as it is issued, before the read: the page ends it if it goes. */
      readonly issued?: (sessionId: string | undefined) => void;
    },
): Promise<
  | { readonly ok: true; readonly sessionId?: string; readonly asked?: AskedForCode }
  | { readonly ok: false; readonly because: string }
> {
  const result = await openSession(request);
  if (!result.ok) return result;
  request.issued?.(result.sessionId);
  const named = result.sessionId === undefined ? {} : { sessionId: result.sessionId };
  // The commands' own client sends the read. Its fetch is named off the request, as App's is:
  // command parity (API-1) reads a bare `fetch` here as a request this file sends itself.
  const client = new OperationsClient({
    origin: request.apiOrigin,
    businessKey: request.businessKey,
    signedIn: false,
    fetch: request.fetch,
    ...named,
  });
  const answer = await client.read('session.person', {});
  const asked = isRefusal(answer) && answer.code === 'AUTH_SECOND_FACTOR_REQUIRED';
  return asked ? { ok: true, ...named, asked: { client, ...named } } : result;
}

/** A provider token handed to the API for this tab's session cookie, and the id it named it. */
export async function tradeForCookie(
  route: ApiRoute,
  token: string,
): Promise<
  | { readonly ok: true; readonly sessionId?: string }
  | { readonly ok: false; readonly because: string }
> {
  const answer = await toApi(route, SESSION_PATH, { authorization: `Bearer ${token}` });
  if (answer === undefined) return { ok: false, because: 'The API did not accept the sign-in.' };
  const body: unknown = await answer.json().catch(() => {});
  const sessionId = (body as { session?: unknown } | undefined)?.session;
  return typeof sessionId === 'string' ? { ok: true, sessionId } : { ok: true };
}

/** The API clears the named sign-in's cookie and no other. */
export async function endCookie(route: ApiRoute, sessionId: string): Promise<void> {
  await toApi(route, `${SESSION_PATH}/end`, { [SESSION_HEADER]: sessionId });
}

/**
 * Sign this tab out. First its sign-in ends for every business, at the API and
 * the provider (C58), on the person prefix: the only path its cookie is sent
 * to. Then the API clears the cookie. The page can do neither itself.
 */
export async function signOut(
  request: ApiRoute & { readonly sessionId?: string; readonly businessKey?: string },
): Promise<void> {
  latest += 1;
  const named = request.sessionId === undefined ? {} : { [SESSION_HEADER]: request.sessionId };
  const { businessKey } = request;
  const account = `${PREFIX.person}${encodeURIComponent(businessKey ?? '')}/account/sessions`;
  const sent = (async () => {
    if (request.sessionId !== undefined && businessKey !== undefined) {
      await toApi(request, `${account}/sign-out`, named, '{}');
    }
    return await toApi(request, `${SESSION_PATH}/end`, named);
  })();
  signingOut.add(sent);
  await sent;
  signingOut.delete(sent);
}

/**
 * Sign out the sign-in a tab has just forgotten (C23): its business key too,
 * so the API ends it where its cookie is sent (C58).
 */
export async function signOutOf(
  route: ApiRoute,
  ended: { readonly sessionId?: string; readonly businessKey: string },
): Promise<void> {
  const named = ended.sessionId === undefined ? {} : { sessionId: ended.sessionId };
  await signOut({
    apiOrigin: route.apiOrigin,
    fetch: route.fetch,
    ...named,
    businessKey: ended.businessKey,
  });
}

/** One call to the session route, with the header its CSRF check asks for. */
async function toApi(
  request: ApiRoute,
  path: string,
  extra: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<Response | undefined> {
  const json = body === undefined ? {} : { 'content-type': 'application/json' };
  const headers = { ...extra, ...json, [CSRF_HEADER]: '1' };
  try {
    const response = await request.fetch(`${request.apiOrigin}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}
