// SPDX-License-Identifier: AGPL-3.0-only
//
// The money step-up (C59): a money command refused `STEP_UP_REQUIRED` is
// answered with the person's authenticator code, and this is the whole of
// what the code does. It is checked on the person's own account route; a good
// one answers a new token for the same provider session, which goes straight
// to the API for a new cookie as sign-in's does; the tab moves to that cookie
// and the API clears the old one.
//
// **The token is held for one call.** It is read from the answer, traded and
// dropped; the refresh token beside it is never read. Nothing here signs out:
// the new token belongs to the same provider session as the old, so the
// provider's sign-out would end the session the tab has just moved to.

import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { describeRefusal } from '../records/submit.ts';
import { endCookie, tradeForCookie, type ApiRoute } from './sign-in.ts';

export type StepUpResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly because: string };

export interface StepUpRequest {
  readonly code: string;
  /** The session's own client, which names the sign-in being stepped up. */
  readonly client: OperationsClient;
  readonly route: ApiRoute;
  /** The sign-in's id now, whose cookie goes once the tab holds the new one. */
  readonly from: string | undefined;
  /** False once the session that asked has ended or been replaced. */
  readonly current: () => boolean;
  /** The tab moves to the new sign-in. Called once, only on a successful trade. */
  readonly adopt: (sessionId: string) => void;
}

const ENDED = 'This sign-in ended before the code was checked. Sign in again.';

export async function stepUpSession(request: StepUpRequest): Promise<StepUpResult> {
  const verified = await request.client.verifyFactor(request.code);
  if (isRefusal(verified)) return { ok: false, because: describeRefusal(verified) };
  if (isUnavailable(verified)) return { ok: false, because: verified.because };
  const token = verified.value.accessToken;
  if (typeof token !== 'string' || token === '') {
    return { ok: false, because: 'The code was accepted and no sign-in came back. Try again.' };
  }
  if (!request.current()) return { ok: false, because: ENDED };
  const traded = await tradeForCookie(request.route, token);
  if (!traded.ok) return traded;
  const { sessionId } = traded;
  if (sessionId === undefined) return { ok: false, because: 'The API named no new sign-in.' };
  if (!request.current()) {
    await endCookie(request.route, sessionId);
    return { ok: false, because: ENDED };
  }
  // Moved first, so no call the tab makes from here names the cookie being cleared.
  request.adopt(sessionId);
  if (request.from !== undefined && request.from !== sessionId) {
    await endCookie(request.route, request.from);
  }
  return { ok: true, sessionId };
}
