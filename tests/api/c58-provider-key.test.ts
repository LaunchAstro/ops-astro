// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's provider credential (ORCH44 21:13Z, ORCH46): an ended login's provider
// steps authenticate to GoTrue's admin API with the admin key batch 1 uses,
// `SUPABASE_SERVICE_KEY`; on a local stack with none set, the short-lived
// service bearer signed with the local key, as the seed tools make it. With
// neither, nothing is sent and the steps stay owed. Sign-in never reads it.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sign, verify } from 'hono/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { providerAdminKey } from '../../apps/api/auth/provider-logins.ts';
import { composeApi } from '../../apps/api/server.ts';
import { TEST_KEY_SET_URL, staticKeySet } from '../support/sign-in.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** A token's header, decoded. */
const headerOf = (token: string): Readonly<Record<string, unknown>> =>
  JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

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

  it('C58 provider credential: SUPABASE_SERVICE_KEY when set, for a hosted issuer', async () => {
    const key = providerAdminKey(
      { SUPABASE_SERVICE_KEY: 'the-service-key', GOTRUE_URL: 'https://abc.supabase.co/auth/v1' },
      local,
    );
    expect(await key?.()).toBe('the-service-key');
  });

  it('C58 provider credential: the service key is never sent in clear text to a non-loopback issuer', () => {
    const settings = { SUPABASE_SERVICE_KEY: `service-key-${randomUUID()}` };
    for (const address of ['http://auth.example.test/auth/v1', 'http://127.0.0.1.example.test']) {
      expect(providerAdminKey({ ...settings, GOTRUE_URL: address }, local), address).toBe(
        undefined,
      );
    }
    expect(
      providerAdminKey({ ...settings, GOTRUE_URL: 'http://127.0.0.1:54391' }, local),
    ).toBeDefined();
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

describe('C58 provider credential: the held note', () => {
  it('C58 provider credential: the held note says an unban would revive the old sessions, so restoring access is a new login', () => {
    for (const file of ['apps/api/auth/logins.ts', 'docs/local/API.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8').replaceAll(/\s+/gu, ' ');
      expect(text, file).not.toMatch(/An unban never restores those sessions/u);
      expect(text, file).toMatch(/unban\b[^.]*\b(revive|would restore)/iu);
    }
  });
});

describe('C58 provider credential: the local mint', () => {
  const local = mkdtempSync(join(tmpdir(), 'c58-mint-'));
  afterAll(() => {
    rmSync(local, { recursive: true, force: true });
  });

  it('C58 provider credential: unset on a loopback issuer, a five-minute service bearer from the local key, minted per call', async () => {
    const file = join(local, 'auth-signing-key.json');
    const first = await localSigningKeys();
    writeFileSync(file, JSON.stringify(first));
    const key = providerAdminKey({ GOTRUE_URL: 'http://127.0.0.1:54391' }, local);
    const token = String(await key?.());
    // Signed by the local key, named by its kid (GoTrue picks the key by it).
    const { d: _private, ...publicHalf } = first[0] ?? {};
    const claims = await verify(token, publicHalf as JsonWebKey, 'ES256');
    expect(headerOf(token)['kid']).toBe(first[0]?.['kid']);
    expect(claims['role']).toBe('service_role');
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(300);
    // Per call: a key made since is the one the next call signs with.
    const second = await localSigningKeys();
    writeFileSync(file, JSON.stringify(second));
    expect(headerOf(String(await key?.()))['kid']).toBe(second[0]?.['kid']);
  });
});
