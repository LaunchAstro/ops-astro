// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6b, the switch-over: the sign-in adapter checks bearers against the
// provider's published key set (S0-6a's verifier), and nothing that can make a
// sign-in token is left in the API.
//
// The invariant test is `S0-6 published keys only`: the API starts as a
// process with no shared secret and verifies a fixture ES256 token. It is red
// until the adapter uses S0-6a's verifier, and red again if the server starts
// reading the secret. `S0-6 signing-key canary` covers where key material may
// go; `local-keys.test.ts` covers the local auth server's key and the fixtures.
//
// Nothing here needs the network or a database. The started server is given a
// database address nobody listens on: a verified bearer gets past sign-in and
// then fails on the database, a refused one stops at sign-in, and that
// difference is the whole measurement.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { sign } from 'hono/jwt';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import {
  serveTestKeySet,
  signBearer,
  TEST_KEY_SET,
  TEST_KEY_SET_URL,
  testSignIn,
  type ServedKeySet,
} from '../support/sign-in.ts';

const ROOT = join(import.meta.dirname, '../..');
const ISSUER = 'http://127.0.0.1:54391';
const OLD_SECRET = 'the-shared-secret-the-api-used-to-hold';
const CREATE = `/api/b/alpha${pathOf('task.create')}`;

const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'mia',
  aud: 'authenticated',
  iss: ISSUER,
  role: 'authenticated',
  iat: now(),
  exp: now() + 600,
  ...over,
});

/** A loopback port nobody holds, by asking the kernel for one. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

function requestWith(token: string): Context['req'] {
  const header = (name: string) =>
    name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined;
  return { header } as unknown as Context['req'];
}

interface Started {
  readonly origin: string;
  readonly output: () => string;
  stop(): Promise<void>;
}

/** `apps/api/server.ts` as a process, with exactly the environment given. */
async function startServer(environment: Record<string, string>): Promise<Started> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const keys = mkdtempSync(join(tmpdir(), 'published-keys-'));
  const child: ChildProcess = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: String(port),
      GATE_SIGNING_KEY_ID: '',
      GATE_SIGNING_SECRET: '',
      DELEGATION_CREDENTIAL_KEY_FILE: join(keys, 'delegation-keys.json'),
      RECOVERY_BUSINESS_KEYS: 'none',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { gone: false, written: '' };
  const collect = (chunk: Buffer) => {
    state.written += chunk.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      state.gone = true;
      resolve();
    });
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (state.gone || state.written.includes('listening')) break;
    // eslint-disable-next-line no-await-in-loop -- polling one server
    await delay(100);
  }
  return {
    origin,
    output: () => state.written,
    stop: async () => {
      if (!state.gone) {
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(keys, { recursive: true, force: true });
    },
  };
}

async function post(origin: string, token: string) {
  const response = await fetch(`${origin}${CREATE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ operationId: 'abcdefgh' }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

describe('S0-6 published keys only', () => {
  let served: ServedKeySet;
  let started: Started;
  let unused: number;

  beforeAll(async () => {
    served = await serveTestKeySet();
    unused = await freePort();
    // No SUPABASE_JWT_SECRET: the server either starts without one or fails here.
    const nowhere = `postgres://app:unused@127.0.0.1:${String(unused)}/none`;
    started = await startServer({
      DATABASE_URL: nowhere,
      DATABASE_ADMIN_URL: nowhere,
      GOTRUE_URL: ISSUER,
      SUPABASE_KEY_SET_URL: served.url,
    });
  }, 30_000);

  afterAll(async () => {
    await started.stop();
    await served.close();
  });

  it('starts with no shared secret in its environment', () => {
    expect(started.output()).toContain('api: listening on');
  });

  it('verifies a fixture ES256 token against the published set', async () => {
    const answer = await post(started.origin, await signBearer(claims()));
    // Past sign-in, the business lookup meets a database nobody runs.
    expect(answer.status).not.toBe(401);
    expect(answer.text).not.toContain('AUTH_UNKNOWN_LOGIN');
  });

  it('refuses a bearer signed with the shared secret it used to hold', async () => {
    const legacy = await sign(claims(), OLD_SECRET, 'HS256');
    const answer = await post(started.origin, legacy);
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.text)).toMatchObject({ code: 'AUTH_UNKNOWN_LOGIN' });
  });

  it('answers a genuine expired ES256 token with the re-login code', async () => {
    const expired = await signBearer(claims({ exp: now() - 60 }));
    const answer = await post(started.origin, expired);
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.text)).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });

  it('refuses to start when the key set is named anywhere but loopback', async () => {
    const elsewhere = await startServer({
      DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/none',
      DATABASE_ADMIN_URL: 'postgres://app:unused@127.0.0.1:1/none',
      GOTRUE_URL: ISSUER,
      SUPABASE_KEY_SET_URL: 'https://keys.example.test/auth/v1/.well-known/jwks.json',
    });
    await elsewhere.stop();
    expect(elsewhere.output()).toContain('SUPABASE_KEY_SET_URL may name a loopback key set only');
    expect(elsewhere.output()).not.toContain('api: listening on');
  });

  it('the adapter hands over the verified subject and nothing else', async () => {
    const verify = createSupabaseVerifier(testSignIn(ISSUER));
    const token = await signBearer(claims({ email: 'mia@alpha.local', role: 'service_role' }));
    expect(await verify(requestWith(token))).toStrictEqual({
      provider: 'supabase',
      subject: 'mia',
    });
  });
});

describe('S0-6 signing-key canary', () => {
  it('a key set carrying private material is refused by reason, and the material reaches no answer or log', async () => {
    const canary = `s0-6-canary-${randomUUID()}`;
    const [published] = TEST_KEY_SET.keys;
    const leaking = { keys: [{ ...published, d: canary }] };
    const lines: unknown[] = [];
    const push = (...parts: unknown[]) => lines.push(...parts) > 0;
    const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = levels.map((level) => vi.spyOn(console, level).mockImplementation(push));
    try {
      const { app } = composeApi({
        database: {} as never,
        admin: {} as never,
        keys: runtimeKeys({}),
        signIn: {
          issuer: ISSUER,
          keySetUrl: TEST_KEY_SET_URL,
          fetch: async () => await Promise.resolve(new Response(JSON.stringify(leaking))),
        },
      });
      const response = await app.fetch(
        new Request(`http://api.test${CREATE}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await signBearer(claims())}`,
          },
          body: '{}',
        }),
      );
      const text = await response.text();
      expect(response.status).toBe(401);
      expect(JSON.parse(text)).toMatchObject({ code: 'AUTH_UNKNOWN_LOGIN' });
      const seen = JSON.stringify([text, lines.map(String)]);
      expect(seen).toContain('private_key');
      expect(seen).not.toContain(canary);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
