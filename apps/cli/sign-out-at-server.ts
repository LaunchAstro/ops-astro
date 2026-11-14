// SPDX-License-Identifier: AGPL-3.0-only
//
// `logout`'s half at the server (#2425). Removing the bearer file ends nothing
// there: a copy of the token keeps working until it expires. So logout also
// posts the person's own `account/sessions/sign-out` (C58) with the bearer it
// read, the route the web's sign-out and a left code step use: it ends the
// session at the door in one transaction with its audit event, then asks the
// provider to revoke its refresh tokens. The route belongs to a business, so
// it needs one named; any business the person is in ends the same session.
//
// Logout removes the files before it asks, and the ask has a time limit, so a
// server that is slow or never answers neither keeps the token on disk nor
// keeps logout waiting. A redirect is never followed (#780): it would resend
// the bearer to whatever origin it names.
//
// The answer is only whether the server confirmed. Nothing it says is printed,
// and the bearer never is.

import { PREFIX } from '../../packages/core-wire/src/index.ts';

export type ServerEnd =
  { readonly ended: true } | { readonly ended: false; readonly because: string | undefined };

/** How long logout waits for the server before it says the session may still be open. */
export const SIGN_OUT_LIMIT_MS = 10_000;

/**
 * Ends `bearer`'s session at `api` through `businessKey`'s account route, or
 * says why not. `because` is undefined when there was nothing to end.
 */
export async function signOutAtServer(
  api: string,
  businessKey: string | undefined,
  bearer: string | undefined,
  limitMs: number = SIGN_OUT_LIMIT_MS,
): Promise<ServerEnd> {
  if (bearer === undefined || bearer === '') return { ended: false, because: undefined };
  if (businessKey === undefined || businessKey === '') {
    return {
      ended: false,
      because: 'no business was named (--business or OPS_ASTRO_BUSINESS) to end it through',
    };
  }
  const path = `${PREFIX.person}${encodeURIComponent(businessKey)}/account/sessions/sign-out`;
  try {
    const answer = await fetch(`${api}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: '{}',
      signal: AbortSignal.timeout(limitMs),
    });
    await answer.body?.cancel();
    return answer.ok
      ? { ended: true }
      : { ended: false, because: `the account route answered ${String(answer.status)}` };
  } catch (cause) {
    const late = (cause as { name?: unknown } | null)?.name === 'TimeoutError';
    return {
      ended: false,
      because: late
        ? 'the account route did not answer in time'
        : 'the account route could not be reached',
    };
  }
}
