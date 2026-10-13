// SPDX-License-Identifier: AGPL-3.0-only
//
// The reset page's calls: the login provider's, on its one-time recovery
// session, and the API's three reset routes. The access token lives in the
// page's memory only, never in the tab's storage, so nobody is signed in. The
// page writes no password at the provider: it hands the new one to the API's
// `changed`, which writes it on the same session and settles the reset only
// on that write's own acknowledgement, inside the reset's window.
//
// Every call uses `redirect: 'error'`, so no answer can send the browser, a
// password or the session's bearer anywhere else, and a provider answer
// counts only from the provider's own origin. Each has its exact
// acknowledgement; anything else is not one:
// - verify: 200 with an `access_token` and the login's `user.id`;
// - `changed`: 200 (a 422 is the provider refusing the password itself:
//   choose another; a 401 is a window that is over: ask for a new link);
// - sign out everywhere: 204 only, so a gateway's 200 is not one. A failure
//   is tried again three times. The reset's window has already ended every
//   session the sign-out would, so it is tidiness, never the security.

import { PASSWORD_RESET_PATHS } from '../../../../packages/core-wire/src/index.ts';

export interface RecoveryRoute {
  /** The provider's own address, its issuer. */
  readonly gotrueUrl: string;
  /** The API's origin: empty for the page's own. */
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

/** How many times a sign-out that was not acknowledged is asked again. */
export const LOGOUT_RETRIES = 3;

type Json = Readonly<Record<string, unknown>>;

const provider = (route: RecoveryRoute, path: string): string =>
  `${route.gotrueUrl.replace(/\/+$/u, '')}${path}`;

/** The answer when it came from `origin`, no redirect followed; nothing otherwise. */
async function ask(
  route: RecoveryRoute,
  url: string,
  init: RequestInit,
): Promise<Response | undefined> {
  try {
    const answer = await route.fetch(url, { ...init, redirect: 'error' });
    const from = URL.canParse(answer.url) ? new URL(answer.url).origin : '';
    const expected = new URL(url, globalThis.location?.href ?? 'http://localhost').origin;
    return from === expected ? answer : undefined;
  } catch {
    return undefined;
  }
}

/** The answer's JSON object, or nothing. */
async function objectOf(answer: Response): Promise<Json | undefined> {
  try {
    const body: unknown = await answer.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Json)
      : undefined;
  } catch {
    return undefined;
  }
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
const JSON_BODY = { 'content-type': 'application/json' };

/** The recovery session, once opened: in the page's memory, for a second try at the password. */
export interface RecoverySession {
  readonly accessToken: string;
  readonly subject: string;
}

/** The provider's recovery session for the mailed link's hash, or nothing. */
export async function verifyRecovery(
  route: RecoveryRoute,
  tokenHash: string,
): Promise<RecoverySession | undefined> {
  const answer = await ask(route, provider(route, '/verify'), {
    method: 'POST',
    headers: JSON_BODY,
    body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }),
  });
  if (answer?.status !== 200) return undefined;
  const body = await objectOf(answer);
  const accessToken = body?.['access_token'];
  const user = body?.['user'];
  const subject = typeof user === 'object' && user !== null ? (user as Json)['id'] : undefined;
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  if (typeof subject !== 'string' || subject === '') return undefined;
  return { accessToken, subject };
}

/** Every session of the login signed out at the provider: true only on its 204. */
export async function signOutEverywhere(
  route: RecoveryRoute,
  accessToken: string,
): Promise<boolean> {
  for (let tried = 0; tried <= LOGOUT_RETRIES; tried += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each try follows the one before
    const answer = await ask(route, provider(route, '/logout?scope=global'), {
      method: 'POST',
      headers: bearer(accessToken),
    });
    if (answer?.status === 204) return true;
  }
  return false;
}

/** One of the API's reset routes: its status, or 0 when none came. */
async function api(
  route: RecoveryRoute,
  path: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly code: unknown }> {
  const answer = await ask(route, `${route.apiOrigin}${path}`, { ...init, method: 'POST' });
  if (answer === undefined) return { status: 0, code: undefined };
  return { status: answer.status, code: (await objectOf(answer))?.['code'] };
}

/** Ask for a link to be mailed. The answer is the same for every address. */
export async function requestReset(route: RecoveryRoute, email: string): Promise<boolean> {
  const answer = await api(route, PASSWORD_RESET_PATHS.reset, {
    headers: JSON_BODY,
    body: JSON.stringify({ email }),
  });
  return answer.status === 202;
}

/** Open the reset's window before the write. */
export async function beginReset(
  route: RecoveryRoute,
  accessToken: string,
): Promise<'begun' | 'invalid' | 'needs-support' | 'failed'> {
  const answer = await api(route, PASSWORD_RESET_PATHS.begin, { headers: bearer(accessToken) });
  if (answer.status === 200) return 'begun';
  if (answer.code === 'RESET_NEEDS_SUPPORT') return 'needs-support';
  return answer.code === 'RESET_LINK_INVALID' ? 'invalid' : 'failed';
}

/** The new password, written by the API on the recovery session, which settles the window. */
export async function writePassword(
  route: RecoveryRoute,
  accessToken: string,
  password: string,
): Promise<'set' | 'refused' | 'invalid' | 'failed'> {
  const answer = await api(route, PASSWORD_RESET_PATHS.changed, {
    headers: { ...JSON_BODY, ...bearer(accessToken) },
    body: JSON.stringify({ password }),
  });
  if (answer.status === 200) return 'set';
  if (answer.code === 'RESET_PASSWORD_REFUSED') return 'refused';
  return answer.code === 'RESET_LINK_INVALID' ? 'invalid' : 'failed';
}

/** Where "Change password" ended: the page's next stage, a password to choose again, or changed. */
export type ChangeOutcome =
  | { readonly stage: 'invalid' | 'needs-support' | 'failed' }
  | { readonly refusal: 'refused' | 'failed' }
  | { readonly stage: 'changed'; readonly signedOut: boolean };

/**
 * "Change password", in its fixed order: open the provider's recovery session
 * with the link's hash (once; a second try keeps it), begin the reset, which
 * ends every session of the login, hand the password to the API's `changed`,
 * which writes it and settles the reset, then sign out everywhere and forget
 * the session.
 */
export async function changePassword(
  route: RecoveryRoute,
  tokenHash: string,
  opened: { current: RecoverySession | null },
  password: string,
): Promise<ChangeOutcome> {
  if (opened.current === null) {
    const session = await verifyRecovery(route, tokenHash);
    if (session === undefined) return { stage: 'invalid' };
    opened.current = session;
  }
  const { accessToken } = opened.current;
  const begun = await beginReset(route, accessToken);
  if (begun !== 'begun') return { stage: begun };
  // Refused or lost, the window stays open to its bound, five minutes on.
  const written = await writePassword(route, accessToken, password);
  if (written === 'invalid') return { stage: 'invalid' };
  if (written !== 'set') return { refusal: written };
  opened.current = null;
  return { stage: 'changed', signedOut: await signOutEverywhere(route, accessToken) };
}
