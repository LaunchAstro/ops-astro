// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier (S0-6a). Signature stub: the tests are written first.

export const KEY_SET_CACHE_MS = 0;
export const KEY_SET_COOLDOWN_MS = 0;
export const KEY_SET_TIMEOUT_MS = 0;
export const KEY_SET_MAX_BYTES = 0;

export type KeySetFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface KeySetRefusal {
  readonly reason: 'network' | 'timeout' | 'status' | 'too_large' | 'shape' | 'private_key';
}

export type KeySetVerdict =
  | { readonly outcome: 'verified'; readonly claims: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'expired' }
  | {
      readonly outcome: 'refused';
      readonly reason:
        'header' | 'algorithm' | 'unknown_key' | 'signature' | 'claims' | 'key_set_unavailable';
    };

export interface KeySetVerifierOptions {
  readonly keySetUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly fetch?: KeySetFetch;
  readonly onRefusal?: (refusal: KeySetRefusal) => void;
}

export type KeySetVerifier = (token: string) => Promise<KeySetVerdict>;

export function createKeySetVerifier(_options: KeySetVerifierOptions): KeySetVerifier {
  throw new Error('createKeySetVerifier: not built yet');
}
