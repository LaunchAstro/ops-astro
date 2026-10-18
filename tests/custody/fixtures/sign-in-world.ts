// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared pieces of the P2 sign-in proofs: a loopback stand-in for OpenAI's
// sign-in origin (OpenID configuration, key set and token endpoint, with a
// real RSA key), a stand-in browser that follows the authorise address to the
// loopback callback, the host registration file seeded through the real
// lock, and the child process that plays a second sign-in. Synthetic token
// text only; it binds 127.0.0.1 only.

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { SignInAsk } from '../../../packages/core-custody/src/plan-sign-in.ts';
import { commitBytes, type PlanTokens } from '../../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../../packages/core-custody/src/token-lock.ts';

export const HOST_ID = 'urn:uuid:00000000-0000-4000-8000-000000000001';
export const ISSUED = 'oaiapp_synthetic-issued';
const KID = 'synthetic-kid';

const keyPair = (): { publicKey: KeyObject; privateKey: KeyObject } =>
  generateKeyPairSync('rsa', { modulusLength: 2048 });

export interface IdClaims {
  readonly [name: string]: unknown;
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const RS256 = { alg: 'RS256', kid: KID };

/** An RS256 ID token over `claims`, signed with `key`. */
export function idToken(
  claims: IdClaims,
  key: KeyObject,
  header: Record<string, unknown> = RS256,
): string {
  const signed = `${part(header)}.${part(claims)}`;
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
}

export interface Grant {
  readonly status?: number;
  readonly body: Record<string, unknown>;
}

export interface SignInIssuer {
  readonly origin: string;
  /** Every token request's form, in order. */
  readonly forms: URLSearchParams[];
  /** The nonce the last authorise address carried, as the browser read it. */
  nonce(): string;
  setNonce(nonce: string): void;
  /** The answer to the next exchange, built from the request; the default is a valid grant. */
  answer(build: (form: URLSearchParams, valid: Record<string, unknown>) => Grant): void;
  /** Claims of a valid ID token for `form`, before any change. */
  claims(form: URLSearchParams, subject?: string): IdClaims;
  readonly key: KeyObject;
  /** A key the issuer never published. */
  readonly strangerKey: KeyObject;
  close(): Promise<void>;
}

export const SUBJECT = 'synthetic-subject-a';

const asBuilt = (_form: URLSearchParams, body: Record<string, unknown>): Grant => ({ body });
const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in origin: its keys, its three routes and its close
export async function startSignInIssuer(tag: string = 'one'): Promise<SignInIssuer> {
  const { publicKey, privateKey } = keyPair();
  const stranger = keyPair().privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const forms: URLSearchParams[] = [];
  let nonce = '';
  let origin = '';
  const claims = (form: URLSearchParams, subject = SUBJECT): IdClaims => ({
    iss: origin,
    aud: form.get('client_id'),
    sub: subject,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  });
  const valid = (form: URLSearchParams): Record<string, unknown> => ({
    access_token: `synthetic-access-${tag}`,
    refresh_token: `synthetic-refresh-${tag}`,
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    id_token: idToken(claims(form), privateKey),
  });
  let build = asBuilt;
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = new URL(req.url ?? '/', origin).pathname;
    if (req.method === 'GET' && path === '/.well-known/openid-configuration')
      return send(res, 200, { issuer: origin, jwks_uri: `${origin}/jwks` });
    if (req.method === 'GET' && path === '/jwks') return send(res, 200, { keys: [jwk] });
    if (req.method === 'POST' && path === '/api/accounts/oauth/token') {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      forms.push(form);
      const grant = build(form, valid(form));
      return send(res, grant.status ?? 200, grant.body);
    }
    return send(res, 404, {});
  };
  const server = createServer((req, res) => {
    void route(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    forms,
    nonce: () => nonce,
    answer: (next) => {
      build = next;
    },
    claims,
    key: privateKey,
    strangerKey: stranger,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    setNonce: (next) => {
      nonce = next;
    },
  };
}

/**
 * The owner's browser: reads the authorise address the sign-in printed, and
 * calls its loopback redirect as OpenAI would after approval.
 */
export function browser(
  issuer: SignInIssuer,
  callback: (asked: URL) => Record<string, string | undefined> = (asked) => ({
    code: 'synthetic-code',
    state: asked.searchParams.get('state') ?? '',
    scope: asked.searchParams.get('scope') ?? '',
    client_id:
      asked.searchParams.get('client_id') === 'dynamic_agent_client'
        ? ISSUED
        : (asked.searchParams.get('client_id') ?? ''),
  }),
): { say(line: string): void; readonly lines: string[]; readonly asked: URL[] } {
  const lines: string[] = [];
  const asked: URL[] = [];
  return {
    lines,
    asked,
    say: (line) => {
      lines.push(line);
      if (!line.startsWith(issuer.origin)) return;
      const address = new URL(line);
      asked.push(address);
      issuer.setNonce(address.searchParams.get('nonce') ?? '');
      const redirect = new URL(address.searchParams.get('redirect_uri') ?? '');
      for (const [name, value] of Object.entries(callback(address)))
        if (value !== undefined) redirect.searchParams.set(name, value);
      void fetch(redirect).catch(() => {});
    },
  };
}

export const hostFile = (file: string): string => join(dirname(file), 'chatgpt-host.json');

export function hostRecord(file: string): unknown {
  return existsSync(hostFile(file)) ? JSON.parse(readFileSync(hostFile(file), 'utf8')) : undefined;
}

export async function seedHost(file: string, record: Record<string, unknown>): Promise<void> {
  const out = await withTokenLock(file, { deadlineAt: Date.now() + 5_000 }, (held) =>
    Promise.resolve(commitBytes(held, hostFile(file), Buffer.from(JSON.stringify(record)))),
  );
  if (!out.held || out.value !== 'durable') throw new Error('host seed failed');
}

/** Every file in the token directory whose bytes hold `text`. */
export function filesHolding(dir: string, text: string): string[] {
  return readdirSync(dir).filter((name) =>
    readFileSync(join(dir, name)).toString('latin1').includes(text),
  );
}

export function signInTokens(
  tag: string,
  expiresAt: number,
  subject: string = SUBJECT,
): PlanTokens {
  return {
    clientId: ISSUED,
    accessToken: `synthetic-access-${tag}`,
    refreshToken: `synthetic-refresh-${tag}`,
    subject,
    expiresAt,
  };
}

/** A second sign-in's final hold in its own process; it answers once on IPC. */
export async function storeInChild(
  file: string,
  ask: SignInAsk,
  tokens: PlanTokens,
): Promise<{ readonly answer: string; readonly output: string }> {
  const child = fork(
    join(import.meta.dirname, 'sign-in-child.ts'),
    [JSON.stringify({ file, ask, tokens })],
    { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const answer = await new Promise<string>((resolve) => {
    child.once('message', (m) => resolve(String((m as { answer: unknown }).answer)));
  });
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
  return { answer, output };
}
