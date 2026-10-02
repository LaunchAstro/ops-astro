// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6b, the local side of the switch-over: the local auth server signs ES256
// with a key `auth-up.sh` generates, the seed tools sign with that key, and the
// test fixtures sign with a test key pair against a static key set.
//
// `auth-up.sh` is run for real, in a copy of the two files it needs inside a
// temporary directory, with stand-ins for `docker` and `curl` on the path. The
// stand-in records every call, so what the auth server would have been started
// with is read back rather than assumed, and no container is touched.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { createKeySetVerifier } from '../../apps/api/auth/jwks.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  signBearer,
  TEST_ISSUER as ISSUER,
  TEST_KEY_SET,
  TEST_KEY_SET_URL,
  testSignIn,
} from '../support/sign-in.ts';
// @ts-expect-error -- a local tool in plain JavaScript, with no declarations
import { generateSigningKeys, serviceToken } from '../../scripts/local/signing-key.mjs';

type Jwk = Record<string, unknown>;
const generate = generateSigningKeys as () => Promise<Jwk[]>;
const mint = serviceToken as (keys: unknown) => Promise<string>;

const ROOT = join(import.meta.dirname, '../..');
const OLD_SECRET = `${ISSUER}/the-shared-secret-the-api-used-to-hold`;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({ sub: 'mia', aud: 'authenticated', iss: ISSUER, exp: now() + 600 });

function requestWith(token: string): Context['req'] {
  const header = (name: string) =>
    name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined;
  return { header } as unknown as Context['req'];
}

/** A checkout from before S0-6b, in a temporary directory: its auth.env holds the secret. */
function sandboxCheckout(): { readonly root: string; readonly calls: string; run(): number } {
  const root = mkdtempSync(join(tmpdir(), 'auth-up-'));
  mkdirSync(join(root, 'scripts/local'), { recursive: true });
  for (const path of ['scripts/local/auth-up.sh', 'scripts/local/signing-key.mjs']) {
    copyFileSync(join(ROOT, path), join(root, path));
  }
  mkdirSync(join(root, '.local'));
  writeFileSync(join(root, '.local/auth.env'), `SUPABASE_JWT_SECRET=${OLD_SECRET}\n`);
  writeFileSync(join(root, '.local/db.env'), 'DATABASE_URL=unused\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'docker-calls');
  // Records each call, one per line, and says nothing exists yet.
  const docker = [
    '#!/usr/bin/env bash',
    `printf '%s\\0' "$@" >> '${calls}'; printf '\\n' >> '${calls}'`,
    'case "$1 ${2:-}" in inspect*|"network inspect"|"volume inspect") exit 1;; esac',
  ].join('\n');
  writeFileSync(join(bin, 'docker'), `${docker}\n`);
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\necho "{}"\n');
  for (const tool of ['docker', 'curl']) chmodSync(join(bin, tool), 0o755);
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: root };
  const script = join(root, 'scripts/local/auth-up.sh');
  return {
    root,
    calls,
    run: () => spawnSync('bash', [script], { env, encoding: 'utf8' }).status ?? -1,
  };
}

describe('S0-6 local keys', () => {
  localKeysCases1();
  localKeysCases2();
});

function localKeysCases1() {
  it('the fixtures sign with a test key pair and read a static key set, with no network', async () => {
    const network = vi.fn(async () => await Promise.reject(new Error('no network in tests')));
    vi.stubGlobal('fetch', network);
    try {
      const verify = createSupabaseVerifier(testSignIn(ISSUER));
      const verified = await verify(requestWith(await signBearer(claims())));
      // Beside `sub`, only the sign-in's assurance (C59, LF-4).
      expect(verified).toStrictEqual({
        provider: 'supabase',
        subject: 'mia',
        assurance: { level: 'aal1', signedInAt: expect.any(Number), factorAt: null },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(network).not.toHaveBeenCalled();
    for (const key of TEST_KEY_SET.keys) {
      for (const member of PRIVATE_MEMBERS) expect(key).not.toHaveProperty(member);
    }
  });

  it('the local key is one ES256 private key, and its published half verifies what the tools sign', async () => {
    const keys = await generate();
    expect(keys).toHaveLength(1);
    const [key] = keys as [Jwk];
    expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(typeof key['d']).toBe('string');
    expect(key['key_ops']).toContain('sign');

    // What GoTrue publishes: the public members, for verifying only.
    const { kty, crv, x, y, alg, kid } = key;
    const set = { keys: [{ kty, crv, x, y, alg, kid, use: 'sig', key_ops: ['verify'] }] };
    const verify = createKeySetVerifier({
      keySetUrl: TEST_KEY_SET_URL,
      issuer: 'ops-astro-local-seed',
      audience: 'authenticated',
      fetch: async () => await Promise.resolve(new Response(JSON.stringify(set))),
    });
    const token = await mint(keys);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
    expect(header).toStrictEqual({ alg: 'ES256', typ: 'JWT', kid });
    const verdict = await verify(token);
    expect(verdict).toMatchObject({ outcome: 'verified', claims: { role: 'service_role' } });
  });
}

function localKeysCases2() {
  describe('auth-up.sh', () => {
    let sandbox: ReturnType<typeof sandboxCheckout>;
    let status: number;
    beforeAll(() => {
      sandbox = sandboxCheckout();
      status = sandbox.run();
    });
    afterAll(() => {
      rmSync(sandbox.root, { recursive: true, force: true });
    });
    const keyFile = () => join(sandbox.root, '.local/auth-signing-key.json');

    it('writes one ES256 private key into a file only its owner can read', () => {
      expect(status).toBe(0);
      expect(statSync(keyFile()).mode & 0o077).toBe(0);
      const keys = JSON.parse(readFileSync(keyFile(), 'utf8')) as Jwk[];
      expect(keys).toMatchObject([{ kty: 'EC', crv: 'P-256', alg: 'ES256' }]);
    });

    it('starts the auth server with that key as GOTRUE_JWT_KEYS', () => {
      const written = readFileSync(keyFile(), 'utf8').trim();
      const auth = readFileSync(sandbox.calls, 'utf8')
        .split('\n')
        .map((line) => line.split('\0'))
        .find((args) => args[0] === 'run' && args.includes('ops-astro-local-auth'));
      expect(auth).toContain(`GOTRUE_JWT_KEYS=${written}`);
      expect(auth?.join(' ')).not.toContain(OLD_SECRET);
    });

    it('leaves no shared secret and no key in the file the API reads', () => {
      const env = readEnvFile(join(sandbox.root, '.local/auth.env'), { required: true });
      expect(Object.keys(env)).not.toContain('SUPABASE_JWT_SECRET');
      for (const value of Object.values(env)) {
        expect(value).not.toContain(OLD_SECRET);
        expect(value).not.toContain('"d"');
      }
      expect(env['GOTRUE_URL']).toBe('http://127.0.0.1:54391');
    });

    it('keeps the key on a second run: a new one would end every session issued', () => {
      const written = readFileSync(keyFile(), 'utf8');
      expect(sandbox.run()).toBe(0);
      expect(readFileSync(keyFile(), 'utf8')).toBe(written);
    });
  });
}

describe('S0-6 signing-key canary', () => {
  it('the local signer refuses a key file it cannot use without repeating any of it', async () => {
    const canary = `s0-6-canary-${randomUUID()}`;
    const unusable = [{ kty: 'EC', crv: 'P-256', alg: 'HS256', kid: 'local', d: canary }];
    const failure: unknown = await mint(unusable).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(`${String(failure)} ${(failure as Error).stack ?? ''}`).not.toContain(canary);
  });

  it('a token the local signer makes carries no private member', async () => {
    const keys = await generate();
    const token = await mint(keys);
    const [key] = keys as [Jwk];
    const decoded = token
      .split('.')
      .slice(0, 2)
      .map((part) => Buffer.from(part, 'base64url').toString('utf8'))
      .join('');
    expect(decoded).not.toContain('"d"');
    expect(token).not.toContain(key['d'] as string);
  });
});
