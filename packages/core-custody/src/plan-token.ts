// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan token as custody holds it on the owner's machine
// (#1620): one file, written by the owner's sign-in and read by custody
// alone, holding an access token, its refresh token and when it expires.
//
// Custody refreshes at the token's earliest refresh time, REFRESH_AHEAD_MS
// before it expires, on its own clock, and only when a call asks for it: no
// timer and no retry loop. Calls in this process take turns, so one refresh
// is in flight and every call that asks meanwhile gets its answer. Across
// processes (another custody, the owner's sign-in) the file's lock is held
// from the read before a refresh to the write after it, and the file is read
// again under it: a refresh token other than the one held means a newer pair
// is there, which is used and nothing is asked. After the provider answers,
// the file must still hold the refresh token refreshed from, or the answer is
// dropped for the file's pair.
//
// The provider rotates the refresh token, so the new pair is written (a new
// file renamed over the old, owner-only) before the new access token is used.
// A write that fails refuses the call `SUBSCRIPTION_STORE_FAILED`, nothing
// sent, and keeps the pair in memory only to write it on the next call; it is
// never presented until it is on disk (and, due by then, it is refreshed
// first). A refresh the provider refuses means
// the owner must sign in again: every call is refused
// `SUBSCRIPTION_SIGN_IN_NEEDED` with nothing sent, and nothing more is asked
// until the file holds a different refresh token. A refresh that fails on the
// way, or a lock not had in time, is refused `SUBSCRIPTION_REFRESH_FAILED`
// for that call only; the next call tries again. No token, code or value is
// ever written to a log: the kinds below only.

import { readTokenFile, TOKEN_TEXT, writeTokenFile, type PlanTokens } from './token-file.ts';
import { withTokenLock } from './token-lock.ts';

/** How long before expiry a token is refreshed: its earliest refresh time. */
export const REFRESH_AHEAD_MS: number = 5 * 60_000;

/** The longest a refresh may take before the call is refused. */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * The token endpoint and the resource every plan token is for, as OpenAI's
 * open-source flow publishes them; its refresh request is read the same way.
 */
export const PLAN_TOKEN_PATH = '/api/accounts/oauth/token';
const PLAN_RESOURCE = 'https://api.openai.com/v1';

/** The largest token answer read. */
const TOKEN_ANSWER_BYTES = 256 * 1024;

export type PlanRefusal =
  | 'SUBSCRIPTION_SIGN_IN_NEEDED'
  | 'SUBSCRIPTION_REFRESH_FAILED'
  | 'SUBSCRIPTION_STORE_FAILED'
  | 'SUBSCRIPTION_TOKEN_FILE_OPEN';

export type TokenAnswer =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly code: PlanRefusal };

export {
  isPlanTokens,
  readTokenFile,
  TOKEN_TEXT,
  writeTokenFile,
  type PlanTokens,
} from './token-file.ts';

/** A token answer's new tokens, or undefined when it is not one. */
function tokensFrom(body: unknown, held: PlanTokens, now: number): PlanTokens | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const shape = body as Record<string, unknown>;
  const access = shape['access_token'];
  const rotated = shape['refresh_token'] ?? held.refreshToken;
  const expiresIn = shape['expires_in'];
  if (
    typeof access !== 'string' ||
    !TOKEN_TEXT.test(access) ||
    typeof rotated !== 'string' ||
    !TOKEN_TEXT.test(rotated) ||
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    return undefined;
  }
  return {
    clientId: held.clientId,
    accessToken: access,
    refreshToken: rotated,
    expiresAt: now + expiresIn * 1000,
    ...(held.subject === undefined ? {} : { subject: held.subject }),
  };
}

export interface TokenHolderOptions {
  readonly file: string;
  /** The provider's token endpoint, whole. */
  readonly tokenUrl: string;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** How the rotated pair is written; tests only make it fail. */
  readonly write?: (file: string, tokens: PlanTokens) => void;
  /** Each thing the holder does, by kind only. */
  readonly log?: (kind: string) => void;
}

export interface TokenHolder {
  /** The access token to present now, refreshed first when it is due. */
  current(): Promise<TokenAnswer>;
}

/** The provider refused the refresh token itself: only a new sign-in helps. */
const refusedGrant = (status: number): boolean => status === 400 || status === 401;

type Refreshed =
  | { readonly kind: 'tokens'; readonly tokens: PlanTokens }
  /** A 200 the holder cannot use whose rotated refresh token it can still keep. */
  | { readonly kind: 'rotated_only'; readonly refreshToken: string }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed' };

/** What one holder keeps between calls. */
interface Held {
  readonly options: TokenHolderOptions;
  readonly now: () => number;
  readonly log: (kind: string) => void;
  /** The refresh token the provider refused; nothing more is asked while the file holds it. */
  dead: string | undefined;
  /** A rotated pair not yet on disk, and the refresh token it replaced. */
  unwritten: { readonly tokens: PlanTokens; readonly from: string } | undefined;
}

const due = (held: Held, tokens: PlanTokens): boolean =>
  held.now() >= tokens.expiresAt - REFRESH_AHEAD_MS;

/** One refresh asked of the provider. */
async function refresh(held: Held, from: PlanTokens): Promise<Refreshed> {
  let answer: Response;
  try {
    answer = await (held.options.fetch ?? fetch)(held.options.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: from.refreshToken,
        client_id: from.clientId,
        resource: PLAN_RESOURCE,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (refusedGrant(answer.status)) return { kind: 'refused' };
  let body: unknown;
  try {
    const text = await answer.text();
    body = text.length <= TOKEN_ANSWER_BYTES && answer.ok ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const next = tokensFrom(body, from, held.now());
  if (next !== undefined) return { kind: 'tokens', tokens: next };
  // The provider has spent the old refresh token: a new one it sent is kept, whatever else failed.
  const rotated = (body as Record<string, unknown> | undefined)?.['refresh_token'];
  return typeof rotated === 'string' && TOKEN_TEXT.test(rotated) && rotated !== from.refreshToken
    ? { kind: 'rotated_only', refreshToken: rotated }
    : { kind: 'failed' };
}

/** Write the rotated pair if the file still holds what it replaced; the answer to give. */
function store(held: Held, tokens: PlanTokens, from: string): TokenAnswer {
  const onDisk = readTokenFile(held.options.file);
  if (typeof onDisk !== 'string' && onDisk.refreshToken !== from) {
    // A newer pair arrived meanwhile: ours is dropped.
    held.unwritten = undefined;
    return { ok: true, accessToken: onDisk.accessToken };
  }
  try {
    (held.options.write ?? writeTokenFile)(held.options.file, tokens);
  } catch {
    held.unwritten = { tokens, from };
    held.log('token store unwritten');
    return { ok: false, code: 'SUBSCRIPTION_STORE_FAILED' };
  }
  held.unwritten = undefined;
  held.log('token refreshed');
  return { ok: true, accessToken: tokens.accessToken };
}

/** Under the lock: the file read again, and refreshed only if it is still the pair seen and due. */
async function locked(held: Held, seen: PlanTokens): Promise<TokenAnswer> {
  let expected = seen.refreshToken;
  if (held.unwritten !== undefined) {
    // The delayed pair goes to disk first; then whatever the file holds is
    // judged as any held pair is, so one already due is refreshed, never presented.
    const stored = store(held, held.unwritten.tokens, held.unwritten.from);
    if (!stored.ok) return stored;
    const written = readTokenFile(held.options.file);
    if (typeof written === 'string') return { ok: false, code: written };
    expected = written.refreshToken;
  }
  const file = readTokenFile(held.options.file);
  if (typeof file === 'string') return { ok: false, code: file };
  if (file.refreshToken !== expected || !due(held, file)) {
    return { ok: true, accessToken: file.accessToken };
  }
  const refreshed = await refresh(held, file);
  if (refreshed.kind === 'tokens') return store(held, refreshed.tokens, file.refreshToken);
  if (refreshed.kind === 'rotated_only') {
    // Kept due now, so the next call refreshes with it; this call sends nothing.
    const kept = { ...file, refreshToken: refreshed.refreshToken, expiresAt: held.now() };
    const stored = store(held, kept, file.refreshToken);
    return stored.ok ? { ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' } : stored;
  }
  const after = readTokenFile(held.options.file);
  if (typeof after !== 'string' && after.refreshToken !== file.refreshToken) {
    // A new sign-in landed meanwhile: its pair, not our refusal, stands.
    return { ok: true, accessToken: after.accessToken };
  }
  if (refreshed.kind === 'refused') {
    held.dead = file.refreshToken;
    held.log('token refresh refused: sign in again');
    return { ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' };
  }
  held.log('token refresh failed');
  return { ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' };
}

/** One call's answer: the file's token when not due, else the locked refresh's. */
async function answerOf(held: Held): Promise<TokenAnswer> {
  const read = readTokenFile(held.options.file);
  if (typeof read === 'string') return { ok: false, code: read };
  if (held.unwritten === undefined) {
    if (read.refreshToken === held.dead) return { ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' };
    held.dead = undefined;
    if (!due(held, read)) return { ok: true, accessToken: read.accessToken };
  }
  const got = await withTokenLock(held.options.file, async () => await locked(held, read));
  return got ?? { ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' };
}

export function tokenHolder(options: TokenHolderOptions): TokenHolder {
  const held: Held = {
    options,
    now: options.now ?? Date.now,
    log: options.log ?? (() => {}),
    dead: undefined,
    unwritten: undefined,
  };
  let turn: Promise<TokenAnswer> | undefined;
  return {
    current: async () => {
      if (turn !== undefined) return await turn;
      turn = answerOf(held).finally(() => {
        turn = undefined;
      });
      return await turn;
    },
  };
}
