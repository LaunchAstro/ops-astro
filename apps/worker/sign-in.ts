// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's own agent login (owner ruling, 11 October 2026). It is handed
// the agent's email and password from custody, never a bearer, and signs in
// through the web's own `signIn` with the hosted service's publishable key, as
// `pnpm cli login` does. A bearer is renewed once four fifths of its life has
// passed, and once more when the API answers `AUTH_SESSION_EXPIRED`
// (`agent-call.ts`). Each renewal is a new password grant, not a refresh: a
// refreshed token keeps the first sign-in's time, and the API's 12-hour limit
// counts from it (C58). Neither the password nor a bearer is ever printed.

import { unredirected } from '../cli/client.ts';
import { withProviderKey } from '../web/src/session/provider-key.ts';
import { signIn } from '../web/src/session/password-grant.ts';

export interface AgentLoginSettings {
  readonly gotrueUrl: string;
  readonly email: string;
  readonly password: string;
  /** The hosted service's publishable key; empty for a local GoTrue. */
  readonly providerKey: string;
}

/** The bearer to present now, and a new one when the API says it expired. */
export interface Bearer {
  readonly current: () => Promise<string>;
  /** A new sign-in, shared by every caller asking at once; `undefined` when it failed. */
  readonly renew: () => Promise<string | undefined>;
}

/** A token's life when GoTrue gives none: staging Auth's own. */
const DEFAULT_LIFE_SECONDS = 3_600;
/** How long after a failed renewal the bearer it still has is used before asking again. */
const RETRY_MS = 30_000;

/**
 * Signed in, or GoTrue's words for why not. `failed` hears why a later
 * renewal failed; the caller's next answer is then the refusal it already had.
 */
export async function agentSignIn(
  settings: AgentLoginSettings,
  failed: (because: string) => void,
  fetcher: typeof fetch = unredirected,
  now: () => number = Date.now,
): Promise<Bearer | { readonly because: string }> {
  const keyed = withProviderKey(fetcher, settings.gotrueUrl, settings.providerKey);
  const grant = async () => {
    const { gotrueUrl, email, password } = settings;
    const result = await signIn({ gotrueUrl, email, password, fetch: keyed });
    if (!result.ok) return result;
    const life = result.expiresIn ?? DEFAULT_LIFE_SECONDS;
    return { token: result.token, renewAt: now() + life * 800 };
  };
  const first = await grant();
  if (!('token' in first)) return { because: first.because };
  let held = first;
  let renewing: Promise<string | undefined> | undefined;
  const renew = async (): Promise<string | undefined> => {
    renewing ??= grant().then((next) => {
      renewing = undefined;
      if ('token' in next) held = next;
      else {
        // The bearer may still be good: no new sign-in is asked on every call meanwhile.
        held = { ...held, renewAt: now() + RETRY_MS };
        failed(next.because);
      }
      return 'token' in next ? next.token : undefined;
    });
    return await renewing;
  };
  return {
    current: async () => (now() < held.renewAt ? held.token : ((await renew()) ?? held.token)),
    renew,
  };
}
