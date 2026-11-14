// SPDX-License-Identifier: AGPL-3.0-only
//
// `logout`'s half at the server (#2425). Removing the bearer file ends nothing
// there: a copy of the token keeps working until it expires. So logout first
// posts the person's own `account/sessions/sign-out` (C58) with the stored
// bearer, the route the web's sign-out and a left code step use: it ends the
// session at the door in one transaction with its audit event, then asks the
// provider to revoke its refresh tokens. The route belongs to a business, so
// it needs one named; any business the person is in ends the same session.
//
// The answer is only whether the server confirmed. Nothing it says is printed,
// and the bearer never is. The caller removes the files whatever this answers.

import { PREFIX } from '../../packages/core-wire/src/index.ts';
import type { Transport } from './client.ts';

export type ServerEnd =
  { readonly ended: true } | { readonly ended: false; readonly because: string | undefined };

/**
 * Ends `bearer`'s session through `businessKey`'s account route, or says why
 * not. `because` is undefined when there was nothing to end (no bearer).
 */
export async function signOutAtServer(
  transport: Transport,
  businessKey: string | undefined,
  bearer: string | undefined,
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
    const answer = await transport(path, '{}', bearer);
    await answer.body?.cancel();
    return answer.ok
      ? { ended: true }
      : { ended: false, because: `the account route answered ${String(answer.status)}` };
  } catch {
    return { ended: false, because: 'the account route could not be reached' };
  }
}
