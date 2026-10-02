// SPDX-License-Identifier: AGPL-3.0-only
//
// Signing in again with the password (C59): how a client, who may have no
// second factor, meets the money step-up, and how anybody gets the fresh
// sign-in that setting up an authenticator app asks for. The password grant
// goes to GoTrue as sign-in's does, its token straight to the API for a new
// cookie, and the tab moves to that cookie.
//
// **Unlike the code's step-up, this is a new provider session.** So once the
// tab holds the new cookie, the old sign-in is signed out where it lives: at
// the API, at the provider and its cookie (`signOutOf`), as a forgotten
// sign-in is.
//
// **The password is held for one call.** It goes to the provider and nowhere
// else: not into state, storage, a log or an error string. The token is read
// from the answer, traded and dropped, as step-up's is.

import { signIn, signOutOf, tradeForCookie, type ApiRoute } from './sign-in.ts';
import type { StepUpResult } from './step-up.ts';

export interface SignInAgainRequest {
  readonly gotrueUrl: string;
  /** The signed-in person's own email, from the session the tab holds. */
  readonly email: string;
  readonly password: string;
  readonly route: ApiRoute;
  /** The business the old sign-in is ended in, where its cookie is sent. */
  readonly businessKey: string;
  /** The sign-in's id now, signed out once the tab holds the new one. */
  readonly from: string | undefined;
  /** False once the session that asked has ended or been replaced. */
  readonly current: () => boolean;
  /** The tab moves to the new sign-in. Called once, only on a successful trade. */
  readonly adopt: (sessionId: string) => void;
}

const ENDED = 'This sign-in ended before the password was checked. Sign in again.';

export async function signInAgainSession(request: SignInAgainRequest): Promise<StepUpResult> {
  const { route } = request;
  const signedIn = await signIn({
    gotrueUrl: request.gotrueUrl,
    email: request.email,
    password: request.password,
    fetch: route.fetch,
  });
  if (!signedIn.ok) return signedIn;
  // Until the tab holds it, a refusal signs the new provider session out with its own token.
  const drop = async (result: StepUpResult): Promise<StepUpResult> => {
    await signOutAtProvider(request.gotrueUrl, signedIn.token, route.fetch);
    return result;
  };
  if (!request.current()) return await drop({ ok: false, because: ENDED });
  const traded = await tradeForCookie(route, signedIn.token);
  if (!traded.ok) return await drop(traded);
  const { sessionId } = traded;
  if (sessionId === undefined) {
    return await drop({ ok: false, because: 'The API named no new sign-in.' });
  }
  // A new provider session nobody will use: ended where it lives, as the old one is below.
  if (!request.current()) {
    await signOutOf(route, { sessionId, businessKey: request.businessKey });
    return { ok: false, because: ENDED };
  }
  // Moved first, so no call the tab makes from here names the sign-in being ended.
  request.adopt(sessionId);
  if (request.from !== undefined && request.from !== sessionId) {
    await signOutOf(route, { sessionId: request.from, businessKey: request.businessKey });
  }
  return { ok: true, sessionId };
}

/** GoTrue's own sign-out of this one session (`scope=local`), with the token it issued. */
async function signOutAtProvider(
  gotrueUrl: string,
  token: string,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  try {
    await fetch(`${gotrueUrl.replace(/\/$/u, '')}/logout?scope=local`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Unreachable: the token is held nowhere, and runs out within the hour.
  }
}
