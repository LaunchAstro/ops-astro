// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan token as custody holds it on the owner's machine
// (#1620): one file, written by the owner's own sign-in
// (`apps/model-agent/chatgpt-sign-in.ts`) and read by custody alone, holding
// an access token, its refresh token and when the access token expires.
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
// never presented until it is on disk. A refresh the provider refuses means
// the owner must sign in again: every call is refused
// `SUBSCRIPTION_SIGN_IN_NEEDED` with nothing sent, and nothing more is asked
// until the file holds a different refresh token. A refresh that fails on the
// way, or a lock not had in time, is refused `SUBSCRIPTION_REFRESH_FAILED`
// for that call only; the next call tries again.
//
// No token, code or value is ever written to a log: the kinds below only.

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { withTokenLock } from './token-lock.ts';

export { withTokenLock } from './token-lock.ts';

/** How long before expiry a token is refreshed: its earliest refresh time. */
export const REFRESH_AHEAD_MS: number = 5 * 60_000;

/** The longest a refresh may take before the call is refused. */
const REFRESH_TIMEOUT_MS = 30_000;

/** The largest token answer read. */
const TOKEN_ANSWER_BYTES = 64 * 1024;

export interface PlanTokens {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Milliseconds since the epoch, on the machine's clock. */
  readonly expiresAt: number;
}

export type PlanRefusal =
  | 'SUBSCRIPTION_SIGN_IN_NEEDED'
  | 'SUBSCRIPTION_REFRESH_FAILED'
  | 'SUBSCRIPTION_STORE_FAILED'
  | 'SUBSCRIPTION_TOKEN_FILE_OPEN';

export type TokenAnswer =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly code: PlanRefusal };

/** Visible ASCII, as a token is written. */
const TOKEN_TEXT = /^[!-~]{8,8192}$/u;

/** The file's tokens, or why they cannot be used: open to others, or not the shape. */
export function readTokenFile(file: string): PlanTokens | PlanRefusal {
  try {
    if ((statSync(file).mode & 0o077) !== 0) return 'SUBSCRIPTION_TOKEN_FILE_OPEN';
    const shape: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof shape !== 'object' || shape === null) return 'SUBSCRIPTION_SIGN_IN_NEEDED';
    const { clientId, accessToken, refreshToken, expiresAt } = shape as Record<string, unknown>;
    if (
      typeof clientId !== 'string' ||
      !TOKEN_TEXT.test(clientId) ||
      typeof accessToken !== 'string' ||
      !TOKEN_TEXT.test(accessToken) ||
      typeof refreshToken !== 'string' ||
      !TOKEN_TEXT.test(refreshToken) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return 'SUBSCRIPTION_SIGN_IN_NEEDED';
    }
    return { clientId, accessToken, refreshToken, expiresAt };
  } catch {
    return 'SUBSCRIPTION_SIGN_IN_NEEDED';
  }
}

/** Write the tokens owner-only: a new file beside the old, renamed over it. */
export function writeTokenFile(file: string, tokens: PlanTokens): void {
  const next = `${file}.${randomBytes(6).toString('hex')}.next`;
  writeFileSync(next, JSON.stringify(tokens), { mode: 0o600, flag: 'wx' });
  renameSync(next, file);
}

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
  return next === undefined ? { kind: 'failed' } : { kind: 'tokens', tokens: next };
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
  if (held.unwritten !== undefined) return store(held, held.unwritten.tokens, held.unwritten.from);
  const file = readTokenFile(held.options.file);
  if (typeof file === 'string') return { ok: false, code: file };
  if (file.refreshToken !== seen.refreshToken || !due(held, file)) {
    return { ok: true, accessToken: file.accessToken };
  }
  const refreshed = await refresh(held, file);
  if (refreshed.kind === 'tokens') return store(held, refreshed.tokens, file.refreshToken);
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
