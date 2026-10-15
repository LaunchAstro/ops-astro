// SPDX-License-Identifier: AGPL-3.0-only
//
// The reset's own verifier, `recoveryBearer`, called directly: a token the
// provider signed is a recovery session only at `aal1`, with an `amr` of
// exactly one `otp` entry stamped within the last 10 minutes (and no more
// than the clock's skew ahead), and a `session_id`. Each case breaks one of
// those and nothing else, so relaxing any one of them fails here.

import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { beforeAll, expect, it } from 'vitest';
import {
  createRecoveryVerifier,
  RECOVERY_SESSION_SECONDS,
  type RecoveryVerifier,
} from '../../apps/api/password-reset.ts';
import { SIGN_IN_CLOCK_SKEW_SECONDS } from '../../packages/core-records/src/index.ts';
import {
  ISSUER,
  KEY_SET_URL,
  keyPair,
  keySet,
  nowSeconds,
  tokenFor,
  type KeyPair,
} from './jwks.fixture.ts';

// The token check reads the real clock; the verifier's own is pinned to the same second.
const NOW = nowSeconds();
const SUBJECT = 'b1d4c0de-0000-4000-8000-000000000001';
const SESSION = randomUUID();

let pair: KeyPair;
let verify: RecoveryVerifier;

beforeAll(async () => {
  pair = await keyPair('recovery');
  const serve = keySet(pair);
  verify = createRecoveryVerifier({
    issuer: ISSUER,
    keySetUrl: KEY_SET_URL,
    fetch: async () => await Promise.resolve(serve()),
    now: () => NOW,
  });
});

const requestWith = (token: string): Context['req'] => {
  const header = (name: string): string | undefined =>
    name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined;
  return { header } as unknown as Context['req'];
};

/** A recovery session's claims as the provider signs them, `overrides` over them. */
const recovery = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: SUBJECT,
  iat: NOW - 60,
  exp: NOW + 3600,
  aal: 'aal1',
  amr: [{ method: 'otp', timestamp: NOW - 60 }],
  session_id: SESSION,
  ...overrides,
});

async function verdict(overrides: Record<string, unknown> = {}) {
  return await verify(requestWith(await tokenFor(pair, recovery(overrides))));
}

it('takes a session a mailed link opened, as its subject, session, sign-in and expiry', async () => {
  const token = await tokenFor(pair, recovery());
  expect(await verify(requestWith(token))).toStrictEqual({
    token,
    subject: SUBJECT,
    sessionId: SESSION,
    signedInAt: NOW - 60,
    expiresAt: NOW + 3600,
  });
});

it('refuses a session with a second factor', async () => {
  expect(await verdict({ aal: 'aal2' })).toBeUndefined();
  expect(await verdict({ aal: undefined })).toBeUndefined();
});

it('refuses an amr of anything but exactly one otp entry', async () => {
  const otp = { method: 'otp', timestamp: NOW - 60 };
  expect(await verdict({ amr: [{ method: 'password', timestamp: NOW - 60 }] })).toBeUndefined();
  expect(await verdict({ amr: [otp, { method: 'totp', timestamp: NOW - 30 }] })).toBeUndefined();
  expect(await verdict({ amr: [otp, otp] })).toBeUndefined();
  expect(await verdict({ amr: [] })).toBeUndefined();
  expect(await verdict({ amr: otp })).toBeUndefined();
  expect(await verdict({ amr: ['otp'] })).toBeUndefined();
  expect(await verdict({ amr: [{ method: 'otp', timestamp: String(NOW - 60) }] })).toBeUndefined();
  expect(await verdict({ amr: [{ method: 'otp', timestamp: NOW - 60.5 }] })).toBeUndefined();
});

/** An `amr` of one `otp` entry stamped at `timestamp`. */
const at = (timestamp: number) => ({ amr: [{ method: 'otp', timestamp }] });

it('takes an otp stamp no older than 10 minutes and no further ahead than the skew', async () => {
  expect(RECOVERY_SESSION_SECONDS).toBe(600);
  expect(await verdict(at(NOW - RECOVERY_SESSION_SECONDS))).not.toBeUndefined();
  expect(await verdict(at(NOW - RECOVERY_SESSION_SECONDS - 1))).toBeUndefined();
  expect(await verdict(at(NOW + SIGN_IN_CLOCK_SKEW_SECONDS))).not.toBeUndefined();
  expect(await verdict(at(NOW + SIGN_IN_CLOCK_SKEW_SECONDS + 1))).toBeUndefined();
});

it('refuses a session with no session id, or one that is not one', async () => {
  expect(await verdict({ session_id: undefined })).toBeUndefined();
  expect(await verdict({ session_id: 'not-a-session' })).toBeUndefined();
});

it('refuses a token with no subject, and a request with no bearer', async () => {
  expect(await verdict({ sub: '' })).toBeUndefined();
  const headers = new Map<string, string>();
  const bare = { header: (name: string) => headers.get(name) } as unknown as Context['req'];
  expect(await verify(bare)).toBeUndefined();
});
