// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
// @ts-expect-error -- existing local JavaScript tool has no declarations
import { serviceToken } from '../../scripts/local/signing-key.mjs';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { bearer, call, personPath } from '../acceptance/world.ts';
import { SESSION_PATH, CSRF_HEADER } from '../../packages/core-wire/src/index.ts';
import { usePasswordWorld, world } from './c40-password-set-world.ts';

usePasswordWorld();
const issuer = process.env['SOL_AUTH_URL'] ?? 'http://127.0.0.1:49930';
const keysPath = process.env['SOL_AUTH_KEYS'] ?? '/tmp/PRV-oa-382-R1-auth-keys.json';

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`provider answer has no string ${key}`);
  return value;
}

async function post(path: string, body: object, token?: string) {
  const response = await fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function codeFor(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const bytes = bits.match(/.{8}/gu) ?? [];
  const key = Buffer.from(bytes.map((one) => Number.parseInt(one, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function realApi() {
  return composeApi({
    database: world.db.app,
    admin: world.db.admin,
    keys: runtimeKeys(process.env),
    signIn: { issuer, keySetUrl: `${issuer}/.well-known/jwks.json` },
    passwordSet: { businesses: async () => [world.alpha] },
  }).app;
}

async function recoveryFor(email: string) {
  const admin = await serviceToken(JSON.parse(readFileSync(keysPath, 'utf8')));
  const link = await post('/admin/generate_link', { type: 'recovery', email }, admin);
  return await post('/verify', { type: 'recovery', token_hash: field(link, 'hashed_token') });
}

it('Sol proof, criterion 1: a pinned GoTrue implicit recovery link sets the password without becoming an ordinary session', async () => {
  const email = `sol-${randomUUID()}@example.test`;
  const signed = await post('/signup', { email, password: `old-password-${randomUUID()}` });
  const subject = field(signed['user'] as Record<string, unknown>, 'id');
  const recovered = await recoveryFor(email);
  const recovery = field(recovered, 'access_token');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const personId = await insertPerson(tx, 'sol-real-implicit');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
  const api = realApi();
  const exchange = await call(
    api,
    SESSION_PATH,
    {},
    {
      ...bearer(recovery),
      [CSRF_HEADER]: '1',
      'sec-fetch-site': 'same-origin',
    },
  );
  const reset = await call(
    api,
    '/api/password/set',
    { password: `new-password-${randomUUID()}` },
    bearer(recovery),
  );
  expect({ exchange: exchange.status, reset: reset.status, resetCode: reset.body['code'] }).toEqual(
    {
      exchange: 401,
      reset: 200,
      resetCode: undefined,
    },
  );
});

it('Sol proof, criterion 7: the named MFA reset case succeeds with a verified factor at the pinned GoTrue provider', async () => {
  const email = `sol-${randomUUID()}@example.test`;
  const password = `old-password-${randomUUID()}`;
  const signed = await post('/signup', { email, password });
  const initial = field(signed, 'access_token');
  const user = signed['user'] as Record<string, unknown>;
  const subject = field(user, 'id');
  const provider = createGoTrueFactors({ baseUrl: issuer });
  // Enrol at the actual provider. The existing adapter's QR cap is unrelated to C40.
  const factor = await post('/factors', { factor_type: 'totp' }, initial);
  const factorId = field(factor, 'id');
  const totp = factor['totp'] as Record<string, unknown>;
  const secret = field(totp, 'secret');
  const verified = await provider.verify(initial, factorId, codeFor(secret));
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error('provider verification failed');
  const recovered = await recoveryFor(email);
  // Model the recovery AMR of the provider's PKCE flow in its own fixture DB,
  // then let the real provider issue the bearer by refreshing that session.
  const claims = JSON.parse(
    Buffer.from(field(recovered, 'access_token').split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  const authDb = connectAsAdmin(
    process.env['SOL_AUTH_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:49826/sol_auth',
  );
  try {
    await authDb.execute(
      `update auth.mfa_amr_claims set authentication_method = 'recovery' where session_id = $1`,
      [field(claims, 'session_id')],
    );
  } finally {
    await authDb.close();
  }
  const refreshed = await post('/token?grant_type=refresh_token', {
    refresh_token: field(recovered, 'refresh_token'),
  });
  const recovery = field(refreshed, 'access_token');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const personId = await insertPerson(tx, 'sol-real-mfa');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    const local = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: factorId,
    });
    await recordFactorVerified(tx, { personId, factorId: local.id, subject });
  });
  const api = realApi();
  // The route also refuses using the recovery bearer to raise its MFA level.
  const stepUp = await call(
    api,
    personPath('alpha', '/account/factor/verify'),
    { code: codeFor(secret) },
    bearer(recovery),
  );
  expect({ status: stepUp.status, code: stepUp.body['code'] }).toEqual({
    status: 401,
    code: 'AUTH_SESSION_EXPIRED',
  });
  const reset = await call(
    api,
    '/api/password/set',
    { password: `new-password-${randomUUID()}` },
    bearer(recovery),
  );
  expect({ status: reset.status, code: reset.body['code'] }).toEqual({
    status: 200,
    code: undefined,
  });
});
