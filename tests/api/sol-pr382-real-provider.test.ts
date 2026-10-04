// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's PR #382 round 1 proofs, criteria 1 and 7, under ORCH77-C40B, at the
// pinned GoTrue (`sol-pr382-proof-containers.mjs` starts it and sets
// SOL_AUTH_URL; without it these skip). A reset sets the password through
// custody's admin update with no provider recovery session anywhere, and an
// MFA login's reset needs our checked second factor first. Custody reaches
// GoTrue through a loopback stand-in for the gateway, which serves the auth
// service under `/auth/v1` as a Supabase deployment's does.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { FactorCodeCheck } from '../../packages/core-commands/src/index.ts';
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

const issuer = process.env['SOL_AUTH_URL'];
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

function realApi(checkFactor?: FactorCodeCheck) {
  return composeApi({
    database: world.db.app,
    admin: world.db.admin,
    keys: runtimeKeys(process.env),
    signIn: { issuer: issuer ?? '', keySetUrl: `${issuer}/.well-known/jwks.json` },
    passwordSet: {
      businesses: async () => await Promise.resolve([world.alpha]),
      broker: held.broker,
      ...(checkFactor === undefined ? {} : { checkFactor }),
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
  'Sol proof, criterion 1: a reset sets the password at the pinned GoTrue through the custody admin update without any provider recovery session',
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
  const signed = await post('/signup', { email, password: `old-password-${randomUUID()}` });
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
  return { email, subject, factorId, secret, provider, aal2: verified.value.accessToken };
}

REAL(
  'Sol proof, criterion 7: an MFA login’s reset needs our verified second factor, then succeeds at the pinned GoTrue',
  async () => {
    const { email, subject, factorId, secret, provider, aal2 } = await mfaLogin();
    // The check the reset is handed: the code proved at the provider, our verdict on it.
    const asked: string[] = [];
    const check: FactorCodeCheck = async (who, id, code) => {
      asked.push(`${who}:${id}`);
      const answer = await provider.verify(aal2, id, code);
      if (answer.ok) return 'good';
      return answer.fault === 'refused' ? 'wrong' : 'fault';
    };
    const api = realApi(check);
    const token = await mintToken(subject);
    const fresh = `new-password-${randomUUID()}`;
    const none = await call(api, '/api/password/set', { token, password: fresh });
    const wrong = await call(api, '/api/password/set', { token, password: fresh, code: '000000' });
    expect([none, wrong].map((one) => [one.status, one.body['code']])).toEqual([
      [401, 'RESET_FACTOR_INVALID'],
      [401, 'RESET_FACTOR_INVALID'],
    ]);
    await signIn(email, fresh, 400);
    // The token was not spent by either: with the code, the same token sets the password.
    const good = await call(api, '/api/password/set', {
      token,
      password: fresh,
      code: codeFor(secret, 1),
    });
    expect({ status: good.status, body: good.body }).toEqual({
      status: 200,
      body: { passwordSet: true },
    });
    expect(asked).toEqual([`${subject}:${factorId}`, `${subject}:${factorId}`]);
    expect(field(await signIn(email, fresh, 200), 'access_token')).not.toBe('');
  },
);
