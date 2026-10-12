// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- the proof bodies are kept as written */
//
// Against a real GoTrue: a confirming sign-in the password change will not keep is signed out
// there even when the first sign-out is lost, so a missing code or a refused new password
// leaves no confirming session behind. Run by `tests/support/password-change-gotrue-proof.mjs`,
// which starts its own throwaway GoTrue; skipped without one.
import { createHmac, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { changePassword } from '../../apps/web/src/session/password-change.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

const issuer = process.env['PASSWORD_PROOF_GOTRUE_URL'];

async function post(path: string, body: object, token?: string) {
  const answer = await fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(answer.status, path).toBe(200);
  return (await answer.json()) as Record<string, unknown>;
}

function codeFor(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function refusalLeavesNoSession(factor: boolean, transient = true): Promise<void> {
  const email = `sol1322-${randomUUID()}@example.test`;
  const password = `synthetic-current-${randomUUID()}`;
  const initial = await post('/signup', { email, password });
  if (factor) {
    const token = String(initial['access_token']);
    const enrolled = await post('/factors', { factor_type: 'totp' }, token);
    const factorId = String(enrolled['id']);
    const challenge = await post(`/factors/${factorId}/challenge`, {}, token);
    const totp = enrolled['totp'] as Record<string, unknown>;
    await post(
      `/factors/${factorId}/verify`,
      {
        challenge_id: challenge['id'],
        code: codeFor(String(totp['secret'])),
      },
      token,
    );
  }
  let confirmingRefresh: string | undefined;
  let logoutAttempts = 0;
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    // One transient gateway failure. A subsequent cleanup attempt reaches real GoTrue.
    if (url.endsWith('/logout?scope=local') && ++logoutAttempts === 1 && transient) {
      return new Response('{}', { status: 503 });
    }
    const response = await fetch(input, init);
    if (url.endsWith('/token?grant_type=password') && response.ok) {
      const body = (await response.clone().json()) as Record<string, unknown>;
      confirmingRefresh = String(body['refresh_token']);
    }
    return response;
  };
  const result = await changePassword({
    gotrueUrl: issuer!,
    email,
    businessKey: 'alpha',
    currentPassword: password,
    newPassword: factor ? `synthetic-new-${randomUUID()}` : password,
    route: { apiOrigin: '', fetch: send },
    client: new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: send,
      sessionId: 'old-cookie',
    }),
    from: 'old-cookie',
    current: () => true,
    adopt: () => {
      throw new Error('A refusal must not adopt');
    },
  });
  expect(result.ok).toBe(false);
  if (factor) expect(result).toMatchObject({ needsCode: true });
  else
    expect(result).toMatchObject({
      because: 'New password should be different from the old password.',
    });
  expect(confirmingRefresh).toBeTruthy();
  const refreshed = await fetch(`${issuer}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: confirmingRefresh }),
  });
  expect(
    refreshed.status,
    'The abandoned confirming sign-in must have been revoked at GoTrue',
  ).toBe(400);
}

it.skipIf(issuer === undefined)(
  'a missing code leaves no confirming GoTrue sign-in after a transient logout failure',
  async () => {
    await refusalLeavesNoSession(true);
  },
);

it.skipIf(issuer === undefined)(
  'a refused new password leaves no confirming GoTrue sign-in after a transient logout failure',
  async () => {
    await refusalLeavesNoSession(false);
  },
);

it.skipIf(issuer === undefined).each([true, false])(
  'an acknowledged GoTrue logout revokes the confirming sign-in, factor=%s',
  async (factor) => {
    await refusalLeavesNoSession(factor, false);
  },
);
