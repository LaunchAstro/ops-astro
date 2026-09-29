// SPDX-License-Identifier: AGPL-3.0-only
//
// The test sign-in keys (S0-6b): one ES256 key pair made for the run, a static
// key set holding its public half, and the signer every test bearer comes
// from. The sign-in adapter checks bearers against the provider's published
// key set, so the tests hand it this set instead.
//
// **No test needs the network.** In-process verifiers read the set through a
// substitute `fetch` that answers from memory. A test that starts
// `apps/api/server.ts` as a process serves the same set on a loopback port of
// its own and names it with `SUPABASE_KEY_SET_URL`; the issuer stays the one
// the tokens carry.
//
// The private half never leaves this module except as signatures.

import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from 'hono/jwt';
import type { KeySetFetch } from '../../apps/api/auth/jwks.ts';
import type { SupabaseVerifierOptions } from '../../apps/api/auth/supabase.ts';

export const TEST_KID = 'test-sign-in-es256';

/** Where an in-process verifier believes the set lives. Never fetched. */
export const TEST_KEY_SET_URL = 'https://keys.example.test/auth/v1/.well-known/jwks.json';

/** A new P-256 pair, the private half as a JWK under the set's `kid`. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: TEST_KID };
  return { privateJwk, publicJwk: publicKey.export({ format: 'jwk' }) };
}

const { privateJwk, publicJwk } = keyPair();

/** The static key set: the public half, shaped as the provider publishes it. */
export const TEST_KEY_SET: { readonly keys: readonly Readonly<Record<string, unknown>>[] } = {
  keys: [
    {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x,
      y: publicJwk.y,
      alg: 'ES256',
      kid: TEST_KID,
      use: 'sig',
      key_ops: ['verify'],
    },
  ],
};

/** An ES256 bearer over `claims`, signed with the run's test key. */
export async function signBearer(claims: Record<string, unknown>): Promise<string> {
  return await sign(claims, privateJwk, 'ES256');
}

const strangerJwk = keyPair().privateJwk;

/**
 * A forgery: ES256 under the set's own `kid`, signed by a key the set does
 * not hold. What a bearer signed with "another secret" was before S0-6b.
 */
export async function signForged(claims: Record<string, unknown>): Promise<string> {
  return await sign(claims, strangerJwk, 'ES256');
}

/** The substitute `fetch`: the static set, from memory, whatever was asked. */
export const staticKeySet: KeySetFetch = async () =>
  await Promise.resolve(
    new Response(JSON.stringify(TEST_KEY_SET), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** The adapter's options for a deployment whose provider stamps `issuer`. */
export function testSignIn(issuer: string): SupabaseVerifierOptions {
  return { issuer, keySetUrl: TEST_KEY_SET_URL, fetch: staticKeySet };
}

export interface ServedKeySet {
  /** The set's loopback address, for `SUPABASE_KEY_SET_URL`. */
  readonly url: string;
  close(): Promise<void>;
}

/** The static set on a loopback port, for a server started as a process. */
export async function serveTestKeySet(body: unknown = TEST_KEY_SET): Promise<ServedKeySet> {
  const server = createServer((request, response) => {
    if (request.url !== '/auth/v1/.well-known/jwks.json') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  // A test's own server: it never keeps the test process alive.
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/auth/v1/.well-known/jwks.json`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      }),
  };
}

let shared: Promise<ServedKeySet> | undefined;

/** One loopback key set for the whole test process: `SUPABASE_KEY_SET_URL`. */
export async function sharedKeySetUrl(): Promise<string> {
  shared ??= serveTestKeySet();
  return (await shared).url;
}
