// SPDX-License-Identifier: AGPL-3.0-only
//
// A fake HTTP endpoint on loopback for the owner's plan proofs: it keeps
// every request it hears, path, headers and body whole, and answers each as
// the test sets. It stands in for the Responses endpoint and the sign-in's
// token endpoint, so no call leaves the machine. `identity` adds the issuer's
// OpenID configuration, its published key and ID tokens signed with it.

import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface Heard {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Fake {
  readonly origin: string;
  readonly heard: Heard[];
  answer: (heard: Heard) => { status: number; type: string; body: string };
  close(): Promise<void>;
}

export async function fake(): Promise<Fake> {
  const state = {
    heard: [] as Heard[],
    answer: (_heard: Heard) => ({ status: 500, type: 'text/plain', body: '' }),
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const heard = { path: request.url ?? '', headers: request.headers, body };
      state.heard.push(heard);
      const answer = state.answer(heard);
      response.writeHead(answer.status, { 'content-type': answer.type });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}

/** A fake issuer's identity half: its OpenID configuration, key set and signed ID tokens. */
export interface Identity {
  /** An RS256 ID token for `claims`, signed with the published key (or `unpublished`). */
  idToken(claims: Record<string, unknown>, signer?: 'published' | 'unpublished'): string;
  /** The answer to a configuration or key-set request, or undefined for any other path. */
  serve(heard: Heard): { status: number; type: string; body: string } | undefined;
}

const json = (body: unknown) => ({
  status: 200,
  type: 'application/json',
  body: JSON.stringify(body),
});

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function identity(origin: string): Identity {
  const published = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const unpublished = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...published.publicKey.export({ format: 'jwk' }), kid: 'fake-key', alg: 'RS256' };
  return {
    idToken: (claims, signer = 'published') => {
      const signed = `${encode({ alg: 'RS256', kid: 'fake-key', typ: 'JWT' })}.${encode(claims)}`;
      const key = (signer === 'published' ? published : unpublished).privateKey;
      return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
    },
    serve: (heard) => {
      if (heard.path === '/.well-known/openid-configuration') {
        return json({ issuer: origin, jwks_uri: `${origin}/.well-known/jwks.json` });
      }
      return heard.path === '/.well-known/jwks.json' ? json({ keys: [jwk] }) : undefined;
    },
  };
}
