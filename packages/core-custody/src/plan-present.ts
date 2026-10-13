// SPDX-License-Identifier: AGPL-3.0-only
//
// How custody presents the owner's plan sign-in (#1620): a credential filed
// `oauth_refresh` is presented as its token file's current access token, as
// a bearer, refreshed first when due at its refresh destination's token
// endpoint (`plan-token.ts`); any other credential as filed. The secrets an
// answer is redacted of are the access token and the refresh token held, so
// neither can come back. A call the plan cannot be presented for is refused
// by code, before custody says `started`.

import type { StoredCredential } from './credentials.ts';
import { readTokenFile, tokenHolder, type TokenHolder } from './plan-token.ts';

export type Presented =
  { readonly credential: StoredCredential; readonly secrets: readonly string[] } | string;

/** The presenter over custody's destinations, one holder per plan credential, made when first asked. */
export function planPresenter(
  originOf: (destination: string) => string | undefined,
  log: (kind: string) => void,
): (credential: StoredCredential) => Promise<Presented> {
  const holders = new Map<string, TokenHolder>();
  return async (credential) => {
    if (credential.scheme !== 'oauth_refresh') return { credential, secrets: [credential.value] };
    const origin = originOf(credential.refreshDestination ?? '');
    const file = credential.tokenFile;
    if (origin === undefined || file === undefined) return 'CUSTODY_CREDENTIAL_UNKNOWN';
    let holder = holders.get(credential.ref);
    if (holder === undefined) {
      holder = tokenHolder({ file, tokenUrl: `${origin}/oauth/token`, log });
      holders.set(credential.ref, holder);
    }
    const token = await holder.current();
    if (!token.ok) return token.code;
    const pair = readTokenFile(file);
    return {
      credential: { ...credential, scheme: 'bearer', value: token.accessToken },
      secrets: [token.accessToken, ...(typeof pair === 'string' ? [] : [pair.refreshToken])],
    };
  };
}
