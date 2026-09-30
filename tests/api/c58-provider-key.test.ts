// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's provider credential (ORCH44 21:13Z, ORCH46): an ended login's provider
// steps authenticate to GoTrue's admin API with the admin key batch 1 uses,
// `SUPABASE_SERVICE_KEY`; on a local stack with none set, the short-lived
// service bearer signed with the local key, as the seed tools make it. With
// neither, nothing is sent and the steps stay owed. Sign-in never reads it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { composeApi, providerAdminKey } from '../../apps/api/server.ts';
import { TEST_KEY_SET_URL, staticKeySet } from '../support/sign-in.ts';

/** One ES256 key as auth-up.sh keeps it in `.local/auth-signing-key.json`. */
async function localSigningKeys(): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const curve = { name: 'ECDSA', namedCurve: 'P-256' };
  const { privateKey } = await crypto.subtle.generateKey(curve, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', privateKey);
  return [{ kty, crv, x, y, d, kid: `local-${randomUUID()}`, alg: 'ES256', use: 'sig' }];
}

interface Heard {
  readonly route: string;
  readonly authorization: string | undefined;
  readonly apikey: string | undefined;
}

let provider: Server;
let issuer: string;
let heard: Heard[] = [];

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response) => {
    request.resume();
    request.on('end', () => {
      heard.push({
        route: `${String(request.method)} ${String(request.url)}`,
        authorization: request.headers.authorization,
        apikey: request.headers['apikey'] as string | undefined,
      });
      const id = /\/admin\/users\/(?<id>[0-9a-f-]{36})$/u.exec(String(request.url))?.groups?.['id'];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, banned_until: '2999-01-01T00:00:00Z' }));
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, '127.0.0.1', resolve);
  });
  issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
  });
});

const composed = (adminKey?: () => Promise<string>) =>
  composeApi({
    database: {} as never,
    admin: {} as never,
    keys: runtimeKeys({}),
    signIn: { issuer, keySetUrl: TEST_KEY_SET_URL, fetch: staticKeySet },
    ...(adminKey === undefined ? {} : { providerAdminKey: adminKey }),
  });

describe('C58 provider credential: the admin key, and only for an ended login', () => {
  it('C58 provider credential: with the admin key set, both steps of an ended login go to the admin API under it', async () => {
    heard = [];
    const key = `service-key-${randomUUID()}`;
    const { logins } = composed(async () => await Promise.resolve(key));
    const subject = randomUUID();
    expect(await logins.endSessions(subject)).toEqual({ ok: true, value: undefined });
    expect(await logins.deactivate(subject)).toEqual({ ok: true, value: undefined });
    const ban = {
      route: `PUT /admin/users/${subject}`,
      authorization: `Bearer ${key}`,
      apikey: key,
    };
    expect(heard).toEqual([ban, ban]);
  });

  it('C58 provider credential: with no admin key, nothing is sent and both steps stay owed', async () => {
    heard = [];
    const { logins } = composed();
    const subject = randomUUID();
    expect(await logins.endSessions(subject)).toEqual({ ok: false, fault: 'unreachable' });
    expect(await logins.deactivate(subject)).toEqual({ ok: false, fault: 'unreachable' });
    expect(heard).toEqual([]);
  });

  it('C58 provider credential: no sign-in path reads it, so a bearer signed with it is no sign-in', async () => {
    const key = `service-key-${randomUUID()}`;
    const { app } = composed(async () => await Promise.resolve(key));
    const now = Math.floor(Date.now() / 1000);
    const forged = await sign(
      { sub: randomUUID(), aud: 'authenticated', iss: issuer, iat: now, exp: now + 60 },
      key,
      'HS256',
    );
    const response = await app.fetch(
      new Request('http://api.test/api/b/alpha/session/capabilities', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'AUTH_UNKNOWN_LOGIN' });
  });
});

describe('C58 provider credential: where the key comes from', () => {
  const local = mkdtempSync(join(tmpdir(), 'c58-key-'));
  afterAll(() => {
    rmSync(local, { recursive: true, force: true });
  });

  it('C58 provider credential: SUPABASE_SERVICE_KEY when set, for any issuer', async () => {
    const key = providerAdminKey(
      { SUPABASE_SERVICE_KEY: 'the-service-key', GOTRUE_URL: 'https://abc.supabase.co/auth/v1' },
      local,
    );
    expect(await key?.()).toBe('the-service-key');
  });

  it('C58 provider credential: unset on a loopback issuer, a five-minute service bearer from the local key, minted per call', async () => {
    writeFileSync(join(local, 'auth-signing-key.json'), JSON.stringify(await localSigningKeys()));
    const key = providerAdminKey({ GOTRUE_URL: 'http://127.0.0.1:54391' }, local);
    const token = await key?.();
    const [, payload = ''] = String(token).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims['role']).toBe('service_role');
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(300);
  });

  it('C58 provider credential: unset on a hosted issuer, or with no local key, there is none', () => {
    expect(providerAdminKey({ GOTRUE_URL: 'https://abc.supabase.co/auth/v1' }, local)).toBe(
      undefined,
    );
    const empty = mkdtempSync(join(tmpdir(), 'c58-none-'));
    try {
      expect(providerAdminKey({ GOTRUE_URL: 'http://127.0.0.1:54391' }, empty)).toBe(undefined);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
