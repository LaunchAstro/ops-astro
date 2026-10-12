// SPDX-License-Identifier: AGPL-3.0-only
//
// Changing one's own password while signed in. A password change is made in the browser
// straight with GoTrue, and the other sessions are ended after it with the person's own
// account route (`docs/local/API.md`, the person's own sessions).
//
// 1. The current password is confirmed by the password grant, as sign-in's is.
// 2. The new one is set at GoTrue with that token. A login with an authenticator app is
//    refused there below `aal2`, so its code is asked; the confirming sign-in is signed out at
//    GoTrue, and the code is checked on the tab's own sign-in through the account route, which
//    counts the codes (C59), and answers the `aal2` token the set is made with.
// 3. The token that set it goes to the API for a new cookie and the tab moves there; then the
//    person's other sessions end, here and at GoTrue, and the old cookie is cleared.
//
// Passwords and tokens are held for their calls: never in state, storage, a log or an answer.

import { createContext } from 'react';
import { isRefusal, isUnavailable, OperationsClient } from '../operations/client.ts';
import { describeFailure } from '../records/submit.ts';
import { setPassword, signIn } from './password-grant.ts';
import { signOutAtProvider } from './sign-in-again.ts';
import { endCookie, tradeForCookie, type ApiRoute } from './sign-in.ts';
import type { Session } from './token.ts';

export interface PasswordChange {
  readonly currentPassword: string;
  readonly newPassword: string;
  /** The authenticator code, once the change has asked for it. */
  readonly code?: string;
}

export type PasswordChangeResult =
  | { readonly ok: true; readonly othersEnded: boolean }
  | { readonly ok: false; readonly because: string; readonly needsCode?: true };

export interface PasswordChangeRequest extends PasswordChange {
  readonly gotrueUrl: string;
  /** The signed-in person's own email, from the session the tab holds. */
  readonly email: string;
  readonly businessKey: string;
  readonly route: ApiRoute;
  /** The tab's own client, whose sign-in checks the code. */
  readonly client: OperationsClient;
  /** The sign-in's id now, whose cookie is cleared once the tab holds the new one. */
  readonly from: string | undefined;
  /** False once the session that asked has ended or been replaced. */
  readonly current: () => boolean;
  /** The tab moves to the new sign-in. */
  readonly adopt: (sessionId: string) => void;
}

/** The application's password change for the tab's own sign-in, or null without a session. */
export const PasswordChangeContext = createContext<
  ((change: PasswordChange) => Promise<PasswordChangeResult>) | null
>(null);

/** What the application holds of a sign-in: the tab's move to a new one, as step-up's is. */
interface Held {
  readonly from: string | undefined;
  readonly current: () => boolean;
  readonly adopt: (sessionId: string) => void;
}

/** The change for the application's signed-in tab, bound to its session, client and moves. */
export function passwordChanger(app: {
  readonly gotrue: string;
  readonly session: Session | null;
  readonly client: OperationsClient;
  readonly route: ApiRoute;
  readonly heldFrom: (from: Session) => Held;
}): (change: PasswordChange) => Promise<PasswordChangeResult> {
  return async (change) => {
    const { session } = app;
    if (session === null) return { ok: false, because: 'Sign in first.' };
    return await changePassword({
      ...change,
      ...app.heldFrom(session),
      gotrueUrl: app.gotrue,
      email: session.email,
      businessKey: session.businessKey,
      route: app.route,
      client: app.client,
    });
  };
}

const NEEDS_CODE = 'Enter the six-digit code from your authenticator app to change your password.';
/** What `/account/sessions/end-others` answers. */
interface SessionsEnded {
  readonly ended: number;
  readonly signedOutAtProvider: boolean;
}

const LEFT = 'This sign-in ended before the password was changed. Nothing changed.';
const CHANGED_ELSEWHERE =
  'Your password is changed, and this sign-in ended meanwhile. Sign in again with it.';

export async function changePassword(
  request: PasswordChangeRequest,
): Promise<PasswordChangeResult> {
  const { gotrueUrl, route } = request;
  const confirmed = await signIn({
    gotrueUrl,
    email: request.email,
    password: request.currentPassword,
    fetch: route.fetch,
  });
  if (!confirmed.ok) return confirmed;
  let token = confirmed.token;
  if (request.code !== undefined) {
    await signOutAtProvider(gotrueUrl, token, route.fetch);
    const raised = await raiseWithCode(request.client, request.code);
    if (!raised.ok) return raised;
    token = raised.token;
  }
  // A sign-out or a switch while the password or code was checked: nothing is written for it.
  if (!request.current()) {
    await dropConfirming(request, token);
    return { ok: false, because: LEFT };
  }
  const set = await setPassword({
    gotrueUrl,
    token,
    password: request.newPassword,
    fetch: route.fetch,
  });
  if (set !== 'set') {
    await dropConfirming(request, token);
    if (set === 'needs-code') return { ok: false, because: NEEDS_CODE, needsCode: true };
    return { ok: false, because: set.because };
  }
  return await moveAndEndOthers(request, token);
}

/**
 * The confirming sign-in, when the token is its, signed out at GoTrue: a token the tab will not
 * hold. With a code the token is the tab's own sign-in's, which stays.
 */
async function dropConfirming(request: PasswordChangeRequest, token: string): Promise<void> {
  if (request.code === undefined) {
    await signOutAtProvider(request.gotrueUrl, token, request.route.fetch);
  }
}

/** The code checked on the tab's own sign-in: the `aal2` token it answers. */
async function raiseWithCode(
  client: OperationsClient,
  code: string,
): Promise<
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly because: string }
> {
  const verified = await client.verifyFactor(code);
  const failed = describeFailure(verified);
  if (failed !== null) return { ok: false, because: failed };
  const token = isRefusal(verified) || isUnavailable(verified) ? '' : verified.value.accessToken;
  if (typeof token !== 'string' || token === '') {
    return { ok: false, because: 'The code was accepted and no sign-in came back. Try again.' };
  }
  return { ok: true, token };
}

/** Step 3: the tab moves to the sign-in that set the password, then every other one ends. */
async function moveAndEndOthers(
  request: PasswordChangeRequest,
  token: string,
): Promise<PasswordChangeResult> {
  const { route, from } = request;
  const traded = request.current() ? await tradeForCookie(route, token) : undefined;
  const sessionId = traded?.ok === true ? traded.sessionId : undefined;
  if (sessionId === undefined || !request.current()) {
    if (sessionId !== undefined) await endCookie(route, sessionId);
    await dropConfirming(request, token);
    return { ok: false, because: CHANGED_ELSEWHERE };
  }
  request.adopt(sessionId);
  const client = new OperationsClient({
    origin: route.apiOrigin,
    businessKey: request.businessKey,
    signedIn: false,
    fetch: route.fetch,
    sessionId,
  });
  const ended = await client.account<SessionsEnded>('sessions/end-others');
  if (from !== undefined && from !== sessionId) await endCookie(route, from);
  // Ended only when the sign-in service said so too, as Settings' own panel reads it.
  const othersEnded = !isRefusal(ended) && !isUnavailable(ended) && ended.value.signedOutAtProvider;
  return { ok: true, othersEnded };
}
