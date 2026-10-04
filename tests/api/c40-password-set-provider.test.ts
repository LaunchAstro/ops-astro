// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's PR #382 round 1 proofs, criteria 1 and 7, under ORCH77-C40B, at the
// pinned GoTrue (`c40-password-set-provider-containers.mjs` starts it and sets
// C40_AUTH_URL; without it these skip). A reset sets the password through
// custody's admin update with no provider recovery session anywhere, and an
// MFA login's reset is refused for support with nothing spent (ORCH77-C40MFA). Custody reaches
// GoTrue through a loopback stand-in for the gateway, which serves the auth
// service under `/auth/v1` as a Supabase deployment's does.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { Broker, Custody } from '../../packages/core-custody/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
// @ts-expect-error -- existing local JavaScript tool has no declarations
import { serviceToken } from '../../scripts/local/signing-key.mjs';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { call } from '../acceptance/world.ts';
import { brokerFor, mintToken, usePasswordWorld, world } from './c40-password-set-world.ts';

const issuer = process.env['C40_AUTH_URL'];
const keysPath = process.env['SOL_AUTH_KEYS'] ?? '';
const REAL = it.skipIf(issuer === undefined || process.env['DATABASE_URL'] === undefined);

usePasswordWorld();

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`provider answer has no string ${key}`);
  return value;
}

async function post(path: string, body: object, token?: string, expected = 200) {
  const response = await fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(expected);
  return (await response.json()) as Record<string, unknown>;
}

const signIn = async (email: string, password: string, expected: number) =>
  await post('/token?grant_type=password', { email, password }, undefined, expected);

function codeFor(secret: string, step = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const bytes = bits.match(/.{8}/gu) ?? [];
  const key = Buffer.from(bytes.map((one) => Number.parseInt(one, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The gateway's part: `/auth/v1/...` to GoTrue's own `/...`, the answer back as it came. */
let gateway: Server;
let held: { readonly broker: Broker; readonly custody: Custody };
let folder: string;

beforeAll(async () => {
  if (issuer === undefined || process.env['DATABASE_URL'] === undefined) return;
  gateway = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').replace(/^\/auth\/v1/u, '');
      void fetch(`${issuer}${path}`, {
        method: request.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: request.headers.authorization ?? '',
        },
        body: Buffer.concat(chunks).toString('utf8'),
      }).then(async (answer) => {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(await answer.text());
        return answer.status;
      });
    });
  });
  await new Promise<void>((resolve) => {
    gateway.listen(0, '127.0.0.1', resolve);
  });
  folder = mkdtempSync(join(tmpdir(), 'sol382-real-'));
  const key = await serviceToken(JSON.parse(readFileSync(keysPath, 'utf8')));
  const origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  held = await brokerFor(origin, key, folder);
}, 60_000);

afterAll(async () => {
  await held?.custody.stop();
  gateway?.close();
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

function realApi() {
  return composeApi({
    database: world.db.app,
    admin: world.db.admin,
    keys: runtimeKeys(process.env),
    signIn: { issuer: issuer ?? '', keySetUrl: `${issuer}/.well-known/jwks.json` },
    passwordSet: {
      businesses: async () => await Promise.resolve([world.alpha]),
      broker: held.broker,
    },
  }).app;
}

/** A provider login mapped to a new member of alpha: its subject. */
async function mapped(subject: string, name: string): Promise<string> {
  return await world.db.app.withBusiness(world.alpha, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return personId;
  });
}

REAL(
  'a reset sets the password at the pinned GoTrue through the custody admin update without any provider recovery session',
  async () => {
    const email = `sol-${randomUUID()}@example.test`;
    const old = `old-password-${randomUUID()}`;
    const signed = await post('/signup', { email, password: old });
    const subject = field(signed['user'] as Record<string, unknown>, 'id');
    await mapped(subject, 'sol-real-token');
    const token = await mintToken(subject);
    const fresh = `new-password-${randomUUID()}`;
    const reset = await call(realApi(), '/api/password/set', { token, password: fresh });
    expect({ status: reset.status, body: reset.body }).toEqual({
      status: 200,
      body: { passwordSet: true },
    });
    // Set at the provider: the new password signs in, the old one no longer does.
    expect(field(await signIn(email, fresh, 200), 'access_token')).not.toBe('');
    await signIn(email, old, 400);
  },
);

/** A provider login with a verified TOTP factor, mapped and mirrored in alpha. */
async function mfaLogin() {
  const email = `sol-${randomUUID()}@example.test`;
  const old = `old-password-${randomUUID()}`;
  const signed = await post('/signup', { email, password: old });
  const initial = field(signed, 'access_token');
  const subject = field(signed['user'] as Record<string, unknown>, 'id');
  const provider = createGoTrueFactors({ baseUrl: issuer ?? '' });
  // Enrol at the actual provider. The existing adapter's QR cap is unrelated to C40.
  const factor = await post('/factors', { factor_type: 'totp' }, initial);
  const factorId = field(factor, 'id');
  const secret = field(factor['totp'] as Record<string, unknown>, 'secret');
  const verified = await provider.verify(initial, factorId, codeFor(secret));
  if (!verified.ok) throw new Error('provider verification failed');
  const personId = await mapped(subject, 'sol-real-mfa');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const local = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: factorId,
    });
    await recordFactorVerified(tx, { personId, factorId: local.id, subject });
  });
  return { email, old, subject, secret };
}

/** Whether the reset token is still unspent, read in alpha. */
async function unspent(token: string): Promise<boolean> {
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await tx.query<{ spent: boolean }>(
        'select spent_at is not null as spent from password_reset_tokens where token_hash = $1',
        [hash],
      ),
  );
  return row?.spent === false;
}

REAL(
  'an MFA login’s reset answers RESET_NEEDS_SUPPORT; token unspent; password unchanged at the pinned GoTrue',
  async () => {
    const { email, old, subject, secret } = await mfaLogin();
    const api = realApi();
    const token = await mintToken(subject);
    const fresh = `new-password-${randomUUID()}`;
    // The same answer with no code, a wrong one and the good one.
    const answers = [];
    for (const code of [undefined, '000000', codeFor(secret)]) {
      const body =
        code === undefined ? { token, password: fresh } : { token, password: fresh, code };
      // oxlint-disable-next-line no-await-in-loop -- one request after another on one token
      const answer = await call(api, '/api/password/set', body);
      answers.push([answer.status, answer.body['code']]);
    }
    expect(answers).toEqual([
      [403, 'RESET_NEEDS_SUPPORT'],
      [403, 'RESET_NEEDS_SUPPORT'],
      [403, 'RESET_NEEDS_SUPPORT'],
    ]);
    expect(await unspent(token)).toBe(true);
    // Unchanged at the provider: the old password signs in, the new one does not.
    await signIn(email, fresh, 400);
    expect(field(await signIn(email, old, 200), 'access_token')).not.toBe('');
  },
);
