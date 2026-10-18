// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in on the M5 (#1620 P2), as OpenAI's open-source
// token-sharing flow publishes it
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
//
//   - Custody's start hold reads this machine's host id, or makes it, and the
//     client id a later sign-in reuses (`beginSignIn`). A first sign-in
//     registers: `client_id=dynamic_agent_client` with the app's name hint,
//     and the callback carries the issued client id.
//   - The loopback listener on `127.0.0.1` starts before the authorise address
//     is shown, with a fresh state, nonce and PKCE S256 verifier. The owner
//     opens the address in a browser that reaches this port (an SSH tunnel
//     from the laptop, `docs/local/chatgpt-plan.md`), so the code exchange
//     and the token file happen on this machine only.
//   - The code is exchanged, form-encoded, with the issued client id. The
//     grant must include plan use, and its ID token must validate against the
//     issuer's published keys. No lock is held while any of this waits.
//   - Custody's final hold then judges the account and the registration again
//     and writes both files (`storeSignIn`). Only a durable record is signed in.
//
// It reads no other sign-in on the machine, Codex's own login included, and
// says nothing secret: each line is fixed text or the authorise address.

import { createHash, randomBytes, type JsonWebKey } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  beginSignIn,
  issuedClientId,
  storeSignIn,
  type SignInAsk,
  type SignInStoreRefusal,
} from '../../packages/core-custody/src/plan-sign-in.ts';
import type { TokenFs } from '../../packages/core-custody/src/token-file.ts';
import { claimsHold, sameIssuer, validatedSubject } from './id-token.ts';

/** The plan's scopes: identity, then plan use. */
export const CHATGPT_PLAN_SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_USE = 'chatgpt.tokens.use.direct';
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';
const REGISTRATION_CLIENT = 'dynamic_agent_client';
const AGENT_NAME = 'Ops Astro';
const AUTHORIZE_PATH = '/api/accounts/authorize';
const TOKEN_PATH = '/api/accounts/oauth/token';
/** The registration's fixed port; a later sign-in may pass another. */
export const SIGN_IN_PORT = 1455;
const CALLBACK = '/auth/callback';
const SIGN_IN_WAIT_MS = 5 * 60_000;
const REQUEST_MS = 30_000;
const ANSWER_BYTES = 1_048_576;

export type SignInRefusal =
  | SignInStoreRefusal
  | 'SIGN_IN_ISSUER_REFUSED'
  | 'SIGN_IN_PORT_BUSY'
  | 'SIGN_IN_STATE_MISMATCH'
  | 'SIGN_IN_DECLINED'
  | 'SIGN_IN_REGISTRATION_INCOMPLETE'
  | 'SIGN_IN_EXCHANGE_FAILED'
  | 'SIGN_IN_PLAN_USE_NOT_GRANTED'
  | 'SIGN_IN_IDENTITY_INVALID'
  | 'SIGN_IN_TIMED_OUT';

export interface SignInOptions {
  /** `https:` origin; `http:` on 127.0.0.1 for tests only. The command pins OpenAI's. */
  readonly issuer: string;
  readonly tokenFile: string;
  /** 0 picks a free port: tests only. */
  readonly port?: number;
  readonly timeoutMs?: number;
  /** Each line said to the owner: never a secret. */
  readonly say: (line: string) => void;
  readonly now?: () => number;
  /** Fault injection for tests; production passes nothing. */
  readonly fs?: Partial<TokenFs>;
}

type Refused = { readonly ok: false; readonly code: SignInRefusal };
const refuse = (code: SignInRefusal): Refused => ({ ok: false, code });
const base64url = (bytes: Buffer): string => bytes.toString('base64url');
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function allowedIssuer(issuer: string): boolean {
  const url = URL.parse(issuer);
  if (url === null || url.origin !== issuer) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
}

/** One sign-in attempt's fresh secrets and the registration it asks under. */
interface Asking extends SignInAsk {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

function authorizeAddress(issuer: string, asking: Asking): string {
  const address = new URL(AUTHORIZE_PATH, issuer);
  const parameters: Record<string, string> = {
    client_id: asking.clientId ?? REGISTRATION_CLIENT,
    ...(asking.clientId === undefined ? { agent_name_hint: AGENT_NAME } : {}),
    ext_agent_host_id: asking.hostId,
    response_type: 'code',
    scope: CHATGPT_PLAN_SCOPES,
    resource: CHATGPT_PLAN_RESOURCE,
    redirect_uri: asking.redirectUri,
    state: asking.state,
    nonce: asking.nonce,
    code_challenge: base64url(createHash('sha256').update(asking.verifier).digest()),
    code_challenge_method: 'S256',
  };
  for (const [name, value] of Object.entries(parameters)) address.searchParams.set(name, value);
  return address.toString();
}

/** The first callback's query, or undefined when the wait ends. */
async function answered(server: Server, timeoutMs: number): Promise<URLSearchParams | undefined> {
  return await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    let done = false;
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (done || request.method !== 'GET' || url.pathname !== CALLBACK) {
        response.writeHead(404).end();
        return;
      }
      done = true;
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Ops Astro: you can close this tab and return to the terminal.');
      clearTimeout(timer);
      resolve(url.searchParams);
    });
  });
}

/** The code and the issued client id the callback carries, or why not. */
function judged(
  query: URLSearchParams,
  asking: Asking,
): { readonly code: string; readonly clientId: string } | Refused {
  if (query.get('state') !== asking.state) return refuse('SIGN_IN_STATE_MISMATCH');
  const code = query.get('code');
  if (query.has('error') || code === null || code === '') return refuse('SIGN_IN_DECLINED');
  const named = query.get('client_id');
  if (asking.clientId !== undefined) {
    // A later sign-in keeps its own client id; a different one is not this registration.
    return named === null || named === asking.clientId
      ? { code, clientId: asking.clientId }
      : refuse('SIGN_IN_REGISTRATION_CHANGED');
  }
  return issuedClientId(named)
    ? { code, clientId: named }
    : refuse('SIGN_IN_REGISTRATION_INCOMPLETE');
}

/** A JSON object from `url`, at most ANSWER_BYTES, with no redirect; else undefined. */
async function json(
  url: URL,
  init: RequestInit = {},
): Promise<Record<string, unknown> | undefined> {
  try {
    const answer = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!answer.ok || answer.body === null) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of answer.body) {
      size += chunk.length;
      if (size > ANSWER_BYTES) return undefined;
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isObject(value) ? value : undefined;
  } catch {
    // The error object is discarded: a parse message can quote the answer.
    return undefined;
  }
}

/** The issuer's published keys, found through its OpenID configuration on its own origin. */
async function publishedKeys(issuer: string): Promise<readonly JsonWebKey[]> {
  const configuration = await json(new URL('/.well-known/openid-configuration', issuer));
  if (configuration === undefined || !sameIssuer(configuration['issuer'], issuer)) return [];
  const uri = URL.parse(String(configuration['jwks_uri']));
  if (uri?.origin !== issuer) return [];
  const set = await json(uri);
  return Array.isArray(set?.['keys']) ? (set['keys'] as JsonWebKey[]) : [];
}

/** The code exchanged, the grant and its ID token judged, and the tokens stored by custody. */
async function finished(
  options: SignInOptions,
  asking: Asking,
  query: URLSearchParams,
): Promise<{ readonly ok: true } | Refused> {
  const got = judged(query, asking);
  if ('ok' in got) return got;
  const now = options.now ?? Date.now;
  const sentAt = now();
  const grant = await json(new URL(TOKEN_PATH, options.issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: got.clientId,
      code: got.code,
      code_verifier: asking.verifier,
      redirect_uri: asking.redirectUri,
      resource: CHATGPT_PLAN_RESOURCE,
    }).toString(),
  });
  if (grant === undefined) return refuse('SIGN_IN_EXCHANGE_FAILED');
  const scope = grant['scope'] ?? query.get('scope');
  if (typeof scope !== 'string' || !scope.split(' ').includes(PLAN_USE))
    return refuse('SIGN_IN_PLAN_USE_NOT_GRANTED');
  const expected = { issuer: options.issuer, clientId: got.clientId, nonce: asking.nonce };
  const claimed = claimsHold(grant['id_token'], { ...expected, now: now() });
  const subject =
    claimed === undefined
      ? undefined
      : validatedSubject(claimed, await publishedKeys(options.issuer));
  if (subject === undefined) return refuse('SIGN_IN_IDENTITY_INVALID');
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = grant;
  if (typeof access !== 'string' || typeof refresh !== 'string')
    return refuse('SIGN_IN_TOKENS_UNUSABLE');
  if (!Number.isSafeInteger(expiresIn) || (expiresIn as number) <= 0)
    return refuse('SIGN_IN_TOKENS_UNUSABLE');
  const tokens = {
    clientId: got.clientId,
    accessToken: access,
    refreshToken: refresh,
    subject,
    expiresAt: sentAt + (expiresIn as number) * 1000,
  };
  return await storeSignIn(
    { file: options.tokenFile, now, ...(options.fs ? { fs: options.fs } : {}) },
    asking,
    tokens,
  );
}

async function listening(server: Server, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
}

export async function signIn(options: SignInOptions): Promise<{ readonly ok: true } | Refused> {
  if (!allowedIssuer(options.issuer)) return refuse('SIGN_IN_ISSUER_REFUSED');
  const store = { file: options.tokenFile, ...(options.now ? { now: options.now } : {}) };
  const begun = await beginSignIn({ ...store, ...(options.fs ? { fs: options.fs } : {}) });
  if (!begun.ok) return begun;
  const server = createServer();
  if (!(await listening(server, options.port ?? SIGN_IN_PORT))) return refuse('SIGN_IN_PORT_BUSY');
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const asking: Asking = {
      hostId: begun.hostId,
      clientId: begun.clientId,
      verifier: base64url(randomBytes(64)),
      state: base64url(randomBytes(32)),
      nonce: base64url(randomBytes(32)),
      redirectUri: `http://127.0.0.1:${String(port)}${CALLBACK}`,
    };
    const waiting = answered(server, options.timeoutMs ?? SIGN_IN_WAIT_MS);
    options.say('Open this address in the browser that reaches this port, and sign in:');
    options.say(authorizeAddress(options.issuer, asking));
    const query = await waiting;
    if (query === undefined) return refuse('SIGN_IN_TIMED_OUT');
    const result = await finished(options, asking, query);
    if (result.ok) options.say('Signed in. The plan token is in custody on this machine only.');
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
