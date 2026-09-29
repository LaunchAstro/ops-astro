// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier: a sign-in token in, one verdict out, checked against
// the provider's published public keys (LF-4). Not yet wired; S0-6b moves the
// sign-in adapter onto it and removes the shared secret.
//
// **The algorithm is pinned, never read from the token.** Only ES256 is
// accepted, and a token naming anything else (`HS256`, `none`) is refused
// before a key is looked up or a fetch is made. A published key is used only
// if its own `alg` is ES256 too, so neither side can choose the algorithm.
//
// **The key set is cached for at most ten minutes**, the provider's own
// figure, and fetched at most once every thirty seconds. A token naming a key
// the cache lacks causes one refetch, and if the key is still unknown the
// token is refused; another unknown key inside the cooldown fetches nothing.
// That bound is what stops a stream of made-up `kid`s from becoming a stream
// of requests to the provider.
//
// **The fetch is to one address and trusts nothing it gets back.** The
// address is fixed at construction (TLS, or plain HTTP on loopback for the
// local auth server), redirects are refused, the whole exchange has a time
// limit, the body has a size cap, and the answer is shape-checked. A set that
// carries private key material is refused outright. Each refused answer is
// recorded by its reason alone. A refused refetch leaves the cached set as it
// was; once that set is older than ten minutes, every token is refused.
//
// Hono's `verifyWithJwks` is not used: it fetches on every call with no cache
// and lets a key with no `alg` take the algorithm from the token's header.

import type { webcrypto } from 'node:crypto';
import { verify } from 'hono/jwt';

/** The longest a fetched key set is trusted, in milliseconds. */
export const KEY_SET_CACHE_MS: number = 10 * 60 * 1000;
/** The shortest gap between two fetches of the key set. */
export const KEY_SET_COOLDOWN_MS: number = 30 * 1000;
/** The time limit on one fetch, the body included. */
export const KEY_SET_TIMEOUT_MS: number = 5 * 1000;
/** The largest key set body read. A real one is well under a kilobyte. */
export const KEY_SET_MAX_BYTES: number = 64 * 1024;
const MAX_KEYS = 32;

export type KeySetFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Why an answer from the provider was refused. Never its content. */
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
  /** The provider's published key set, `…/.well-known/jwks.json`. */
  readonly keySetUrl: string;
  /** The `iss` the provider stamps on its tokens. */
  readonly issuer: string;
  /** The `aud` of a signed-in session. */
  readonly audience: string;
  readonly fetch?: KeySetFetch;
  /** Told each refused answer, by reason only. */
  readonly onRefusal?: (refusal: KeySetRefusal) => void;
}

export type KeySetVerifier = (token: string) => Promise<KeySetVerdict>;

type Refused = Extract<KeySetVerdict, { outcome: 'refused' }>['reason'];
type Checks = Parameters<typeof verify>[2];
// The key type `crypto.subtle` itself returns, so the same line typechecks
// under Node's declarations and under the DOM's (the web program imports this
// file through the sign-in adapter).
type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeySet = ReadonlyMap<string, ImportedKey>;
type Loaded = KeySet | KeySetRefusal['reason'];

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const COORDINATE = /^[\w-]{43}$/u;
const SEGMENT = /^[\w-]+$/u;
const CLAIM_ERRORS = new Set([
  'JwtTokenExpired',
  'JwtTokenNotBefore',
  'JwtTokenIssuedAt',
  'JwtTokenIssuer',
  'JwtPayloadRequiresAud',
  'JwtTokenAudience',
]);

export function createKeySetVerifier(options: KeySetVerifierOptions): KeySetVerifier {
  const keySetUrl = pinnedAddress(options.keySetUrl);
  if (options.issuer === '' || options.audience === '') {
    throw new Error('createKeySetVerifier: the issuer and audience must be named');
  }
  const fetchKeySet = options.fetch ?? ((url, init) => fetch(url, init));
  const expected = { alg: 'ES256', aud: options.audience, iss: options.issuer } as const;

  let cached: { readonly keys: KeySet; readonly at: number } | undefined;
  let lastAttempt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const fresh = (): KeySet | undefined =>
    cached !== undefined && Date.now() - cached.at < KEY_SET_CACHE_MS ? cached.keys : undefined;

  async function refresh(): Promise<void> {
    const started = Date.now();
    lastAttempt = started;
    const loaded = await load(keySetUrl, fetchKeySet);
    if (typeof loaded === 'string') options.onRefusal?.({ reason: loaded });
    else cached = { keys: loaded, at: started };
  }

  async function keyFor(kid: string): Promise<ImportedKey | 'unknown_key' | 'key_set_unavailable'> {
    const known = fresh()?.get(kid);
    if (known !== undefined) return known;
    const mayFetch = lastAttempt === undefined || Date.now() - lastAttempt >= KEY_SET_COOLDOWN_MS;
    if (inFlight === undefined && mayFetch) {
      inFlight = refresh().finally(() => {
        inFlight = undefined;
      });
    }
    if (inFlight !== undefined) await inFlight;
    const keys = fresh();
    if (keys === undefined) return 'key_set_unavailable';
    return keys.get(kid) ?? 'unknown_key';
  }

  return async function verifyWithKeySet(token: string): Promise<KeySetVerdict> {
    const header = headerOf(token);
    if (header === undefined) return refused('header');
    if (header['alg'] !== 'ES256') return refused('algorithm');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid === '') return refused('header');

    const key = await keyFor(kid);
    if (typeof key === 'string') return refused(key);

    const first = await attempt(token, key, expected);
    if (first.ok) {
      const claims = first.claims;
      return typeof claims['exp'] === 'number'
        ? { outcome: 'verified', claims }
        : refused('claims');
    }
    if (first.error !== 'JwtTokenExpired') return refused(reasonOf(first.error));
    // `hono/jwt` checks `exp` before the signature, so its expiry error proves
    // nothing about who signed. Only a token that verifies with every other
    // check still on is a genuine expired session.
    const again = await attempt(token, key, { ...expected, exp: false });
    return again.ok ? { outcome: 'expired' } : refused(reasonOf(again.error));
  };
}

function refused(reason: Refused): KeySetVerdict {
  return { outcome: 'refused', reason };
}

function reasonOf(error: string): Refused {
  return CLAIM_ERRORS.has(error) ? 'claims' : 'signature';
}

type Attempt =
  | { readonly ok: true; readonly claims: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

async function attempt(token: string, key: ImportedKey, checks: Checks): Promise<Attempt> {
  try {
    return { ok: true, claims: (await verify(token, key, checks)) as Record<string, unknown> };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.name : 'unknown' };
  }
}

/**
 * The token's header, read only to choose a key. No claim is read from an
 * unverified token: the payload is untouched until `verify` has checked it.
 */
function headerOf(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !SEGMENT.test(parts[0] ?? '')) return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && !Array.isArray(header)
      ? (header as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function pinnedAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('createKeySetVerifier: the key set address is not a URL');
  }
  const transport =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (
    !transport ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/.well-known/jwks.json')
  ) {
    throw new Error(
      'createKeySetVerifier: the key set address must be a published key set over TLS, or loopback',
    );
  }
  return url.href;
}

async function load(url: string, fetchKeySet: KeySetFetch): Promise<Loaded> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, KEY_SET_TIMEOUT_MS);
  try {
    const response = await fetchKeySet(url, { redirect: 'error', signal: controller.signal });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel();
      return 'status';
    }
    if (Number(response.headers.get('content-length') ?? 0) > KEY_SET_MAX_BYTES) {
      await response.body?.cancel();
      return 'too_large';
    }
    const body = await readCapped(response);
    return body === undefined ? 'too_large' : await parseKeySet(body);
  } catch {
    return timedOut ? 'timeout' : 'network';
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    // Leaving the loop cancels the rest of the stream.
    if (total > KEY_SET_MAX_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The shape check: `{ keys: [...] }`, public members only, one entry per `kid`. */
async function parseKeySet(body: Uint8Array): Promise<Loaded> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return 'shape';
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) return 'shape';
  if (!keys.every((key) => typeof key === 'object' && key !== null && !Array.isArray(key))) {
    return 'shape';
  }
  const entries = keys as Record<string, unknown>[];
  if (entries.some((key) => PRIVATE_MEMBERS.some((member) => member in key))) return 'private_key';
  const kids = entries.map((key) => key['kid']).filter((kid) => typeof kid === 'string');
  if (new Set(kids).size !== kids.length) return 'shape';

  // An entry that names ES256 is one this verifier would use, so it is whole
  // or the answer is refused; it is never quietly skipped beside a good key.
  // Entries naming another algorithm are left alone.
  const claimed = entries.filter((key) => key['alg'] === 'ES256');
  if (!claimed.every((key) => isUsable(key))) return 'shape';

  const usable = new Map<string, ImportedKey>();
  const imports = claimed.map(async (key) => {
    const imported = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: key['x'], y: key['y'] } as webcrypto.JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    usable.set(key['kid'] as string, imported);
  });
  try {
    await Promise.all(imports);
  } catch {
    // A coordinate pair that is not a point on the curve.
    return 'shape';
  }
  return usable;
}

/** A complete ES256 public key: the only shape an ES256 entry may have. */
function isUsable(key: Record<string, unknown>): boolean {
  const ops = key['key_ops'];
  return (
    key['kty'] === 'EC' &&
    key['crv'] === 'P-256' &&
    key['alg'] === 'ES256' &&
    typeof key['kid'] === 'string' &&
    key['kid'] !== '' &&
    typeof key['x'] === 'string' &&
    COORDINATE.test(key['x']) &&
    typeof key['y'] === 'string' &&
    COORDINATE.test(key['y']) &&
    (key['use'] === undefined || key['use'] === 'sig') &&
    (ops === undefined || (Array.isArray(ops) && ops.includes('verify')))
  );
}
