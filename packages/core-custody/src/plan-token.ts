// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token holder (#1620 P1). `prepare()` is the only path that reads
// or writes the token file: under one plan token lock, with one deadline for
// the lock wait and the request, it reads the committed record, refreshes a
// due pair with exactly one request after a durable `pending`, and holds the
// presentable pair in memory. `present()` is synchronous: no file, no lock, no
// refresh. Its one importer is `plan-token-production.ts`, custody's plan holder.

import {
  FIELD_MAX,
  commitTokenFile,
  committedDigest,
  encodeTokenFile,
  readBytesLocked,
  readTokenFileLocked,
  sha256,
  tokenText,
  type CommitOutcome,
  type OnDisk,
  type PlanTokens,
  type TokenFile,
  type TokenFs,
} from './token-file.ts';
import { withTokenLock, type HeldLock } from './token-lock.ts';
import { issuerCopy, refreshOnce, type RefreshResult } from './token-refresh.ts';

export const REFRESH_AHEAD_MS: number = 5 * 60_000;
export const PREPARE_HORIZON_MS = 60_000;
export const PREPARE_BOUND_MS = 30_000;
export type PlanRefusal =
  | 'SUBSCRIPTION_SIGN_IN_NEEDED'
  | 'SUBSCRIPTION_REFRESH_FAILED'
  | 'SUBSCRIPTION_STORE_FAILED'
  | 'SUBSCRIPTION_TOKEN_FILE_OPEN';
export type TokenAnswer =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly code: 'SUBSCRIPTION_REFRESH_FAILED' };
export type PlanLogKind =
  | 'token refreshed'
  | 'token rotated only'
  | 'token refresh not sent'
  | 'token refresh refused: sign in again'
  | 'token refresh unresolved: sign in again'
  | 'token store failed'
  | 'token store exposed'
  | 'token store unconfirmed'
  | 'token store recovered';
export interface TokenHolderOptions {
  readonly file: string;
  /** The plan issuer, or a 127.0.0.1 issuer for tests only; anything else throws at build. Copied. */
  readonly tokenUrl: URL;
  readonly now?: () => number;
  readonly log?: (kind: PlanLogKind) => void;
  /** Fault injection for tests; production passes nothing. */
  readonly fs?: Partial<TokenFs>;
}
export interface TokenHolder {
  prepare(): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: PlanRefusal }>;
  present(): TokenAnswer;
  /** Every token value held in memory, for P3. */
  secrets(): readonly string[];
}
type Prepared = { readonly ok: true } | { readonly ok: false; readonly code: PlanRefusal };

const DEADLINE_POLL_MS = 50;
const OK: Prepared = { ok: true };
const refuse = (code: PlanRefusal): Prepared => ({ ok: false, code });

/** The sign-in seam's final judgement, made under the same hold as its commit. */
export function signInVerdict(
  onDisk: OnDisk,
  subject: string,
): 'write' | 'SIGN_IN_OTHER_ACCOUNT' | 'SIGN_IN_FILE_NEEDS_OWNER' {
  if (onDisk.state === 'absent') return 'write';
  if (onDisk.state === 'refused') return 'SIGN_IN_FILE_NEEDS_OWNER';
  const owner = onDisk.state === 'spent' ? onDisk.subject : onDisk.tokens.subject;
  return owner === subject ? 'write' : 'SIGN_IN_OTHER_ACCOUNT';
}

const usable = (value: unknown, max: number): value is string =>
  typeof value === 'string' && tokenText(max).test(value);

type Next =
  | {
      readonly kind: 'store';
      readonly record: TokenFile;
      readonly log: PlanLogKind;
      readonly answer: 'horizon' | PlanRefusal;
    }
  | { readonly kind: 'keep'; readonly log: PlanLogKind; readonly answer: PlanRefusal };

/** What the one request's result asks to be stored (lifecycle step 3). */
function afterRequest(result: RefreshResult, from: PlanTokens, t: number, sentAt: number): Next {
  if (result.kind === 'not_sent')
    return {
      kind: 'store',
      record: { state: 'ready', tokens: from },
      log: 'token refresh not sent',
      answer: 'SUBSCRIPTION_REFRESH_FAILED',
    };
  if (result.kind === 'refused') {
    return {
      kind: 'store',
      record: { state: 'spent', subject: from.subject },
      log: 'token refresh refused: sign in again',
      answer: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    };
  }
  const unresolved: Next = {
    kind: 'keep',
    log: 'token refresh unresolved: sign in again',
    answer: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  };
  if (result.kind === 'unknown' || typeof result.body !== 'object' || result.body === null)
    return unresolved;
  return fromAnswer(result.body as Record<string, unknown>, from, t, sentAt) ?? unresolved;
}

/** A usable 200: a fresh pair, or only a rotated refresh token (`rotated_only`). */
function fromAnswer(
  body: Record<string, unknown>,
  from: PlanTokens,
  t: number,
  sentAt: number,
): Next | undefined {
  const refresh = body['refresh_token'];
  if (refresh !== undefined && !usable(refresh, FIELD_MAX.refreshToken)) return;
  const expiresIn = body['expires_in'];
  const lifetime =
    Number.isSafeInteger(expiresIn) && (expiresIn as number) > 0
      ? (expiresIn as number) * 1000
      : undefined;
  const access = body['access_token'];
  if (
    usable(access, FIELD_MAX.accessToken) &&
    lifetime !== undefined &&
    Number.isSafeInteger(sentAt + lifetime)
  ) {
    const tokens = {
      ...from,
      accessToken: access,
      refreshToken: refresh ?? from.refreshToken,
      expiresAt: sentAt + lifetime,
    };
    return {
      kind: 'store',
      record: { state: 'ready', tokens },
      log: 'token refreshed',
      answer: 'horizon',
    };
  }
  if (refresh === undefined) return;
  const tokens = { ...from, refreshToken: refresh, expiresAt: t };
  return {
    kind: 'store',
    record: { state: 'ready', tokens },
    log: 'token rotated only',
    answer: 'SUBSCRIPTION_REFRESH_FAILED',
  };
}

// oxlint-disable-next-line max-lines-per-function -- one holder's state (held pair, unwritten record, prepare in flight) and the steps that change it
export function tokenHolder(options: TokenHolderOptions): TokenHolder {
  const { file } = options;
  const tokenUrl = issuerCopy(options.tokenUrl);
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const fs = options.fs ?? {};
  let pair: PlanTokens | undefined;
  /** A post-answer record this holder failed to commit, with the pending it answers. */
  let unwritten:
    { readonly record: TokenFile; readonly bytes: Buffer; readonly pending: Buffer } | undefined;
  let inFlight: Promise<Prepared> | undefined;
  /** The locked pair while its refresh is carried; still held in memory until the hold ends. */
  let carrying: PlanTokens | undefined;

  const commit = (held: HeldLock, record: TokenFile): CommitOutcome => {
    const out = commitTokenFile(held, file, record, fs);
    if (out === 'exposed') log('token store exposed');
    else if (out === 'unconfirmed') log('token store unconfirmed');
    else if (out !== 'durable') log('token store failed');
    return out;
  };

  /** Lifecycle step 1: only this holder, only while its pending is still the committed record. */
  const recover = (held: HeldLock): 'go' | 'failed' => {
    if (unwritten === undefined) return 'go';
    const digest = committedDigest(held, file);
    if (digest === 'failed') return 'failed';
    if (digest === undefined || !digest.equals(sha256(unwritten.pending))) {
      unwritten = undefined;
      return 'go';
    }
    const visible = readBytesLocked(held, file, fs);
    if (
      !Buffer.isBuffer(visible) ||
      !(visible.equals(unwritten.pending) || visible.equals(unwritten.bytes))
    )
      return 'failed';
    if (commit(held, unwritten.record) !== 'durable') return 'failed';
    log('token store recovered');
    unwritten = undefined;
    return 'go';
  };

  const hold = async (held: HeldLock, lapse: () => AbortSignal): Promise<Prepared> => {
    if (recover(held) === 'failed') return refuse('SUBSCRIPTION_STORE_FAILED');
    const onDisk = readTokenFileLocked(held, file, fs);
    const t = now();
    if (onDisk.state === 'refused') {
      pair = undefined;
      return refuse(onDisk.code);
    }
    if (onDisk.state !== 'ready') {
      pair = undefined;
      return refuse('SUBSCRIPTION_SIGN_IN_NEEDED');
    }
    const from = onDisk.tokens;
    if (t < from.expiresAt - REFRESH_AHEAD_MS - PREPARE_HORIZON_MS) {
      pair = from;
      return OK;
    }
    const pending: TokenFile = { state: 'pending', tokens: from, since: t };
    const pendingBytes = encodeTokenFile(pending);
    if (!Buffer.isBuffer(pendingBytes) || commit(held, pending) !== 'durable')
      return refuse('SUBSCRIPTION_STORE_FAILED');
    carrying = from;
    // Judged after the pending write: a deadline already passed sends nothing.
    const { result, sentAt } = await refreshOnce(tokenUrl, from, lapse, now);
    const next = afterRequest(result, from, t, sentAt ?? t);
    log(next.log);
    if (next.kind === 'keep') return refuse(next.answer);
    const bytes = encodeTokenFile(next.record);
    if (!Buffer.isBuffer(bytes)) return refuse('SUBSCRIPTION_SIGN_IN_NEEDED');
    if (commit(held, next.record) !== 'durable') {
      unwritten = { record: next.record, bytes, pending: pendingBytes };
      return refuse('SUBSCRIPTION_STORE_FAILED');
    }
    const stored = next.record;
    if (stored.state !== 'ready')
      return refuse(next.answer === 'horizon' ? 'SUBSCRIPTION_SIGN_IN_NEEDED' : next.answer);
    pair = stored.tokens;
    if (next.answer !== 'horizon') return refuse(next.answer);
    const u = now();
    return u < stored.tokens.expiresAt - REFRESH_AHEAD_MS - PREPARE_HORIZON_MS
      ? OK
      : refuse('SUBSCRIPTION_REFRESH_FAILED');
  };

  const run = async (): Promise<Prepared> => {
    const deadlineAt = now() + PREPARE_BOUND_MS;
    const abort = new AbortController();
    const lapse = (): AbortSignal => {
      if (now() >= deadlineAt) abort.abort();
      return abort.signal;
    };
    const watch = setInterval(lapse, DEADLINE_POLL_MS);
    try {
      const out = await withTokenLock(file, { deadlineAt, now }, (held) => hold(held, lapse));
      if (out.held) return out.value;
      return refuse(
        out.why === 'LOCK_WAIT_LAPSED'
          ? 'SUBSCRIPTION_REFRESH_FAILED'
          : 'SUBSCRIPTION_STORE_FAILED',
      );
    } catch {
      return refuse('SUBSCRIPTION_STORE_FAILED');
    } finally {
      clearInterval(watch);
      carrying = undefined;
    }
  };

  return {
    prepare: () => {
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    present: () => {
      const t = now();
      return pair !== undefined && t < pair.expiresAt - REFRESH_AHEAD_MS
        ? { ok: true, accessToken: pair.accessToken }
        : { ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' };
    },
    secrets: () => {
      const held = [
        pair,
        carrying,
        unwritten?.record.state === 'spent' ? undefined : unwritten?.record.tokens,
      ];
      return [
        ...new Set(held.flatMap((t) => (t === undefined ? [] : [t.accessToken, t.refreshToken]))),
      ];
    },
  };
}
