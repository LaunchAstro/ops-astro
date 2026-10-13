// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's sign-in to the ChatGPT plan, run by the owner on the owner's
// machine (#1620, `docs/local/chatgpt-plan.md`), as OpenAI's open-source
// token-sharing flow publishes it
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
//
//   - The first sign-in registers Ops Astro for this ChatGPT account: it
//     authorizes with `client_id=dynamic_agent_client`, the app's name hint
//     and this machine's host id (`urn:uuid:`, kept in `chatgpt-host.json`
//     beside the token file). The owner names the agent and approves in the
//     browser, and the callback carries the issued client id, which is saved
//     in custody's token file. A later sign-in sends that id and no hint.
//   - It asks for the plan's scopes and the API resource, with a fresh state
//     and nonce and a PKCE S256 challenge, back to a `127.0.0.1` loopback
//     redirect, never `localhost`.
//   - The code is exchanged, form-encoded, at the token endpoint with the
//     issued id, the verifier, the same redirect and the same resource, and
//     the grant must include plan use. The tokens are written under custody's
//     lock, owner-only (`plan-token.ts`).
//
// It reads no other sign-in on the machine, and says nothing secret: no
// token, code or verifier. The owner runs it as `chatgpt-sign-in-command.ts`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import {
  readTokenFile,
  withTokenLock,
  writeTokenFile,
} from '../../packages/core-custody/src/plan-token.ts';

/** The plan's scopes: identity, then plan use, as the open-source flow asks for them. */
export const CHATGPT_PLAN_SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

/** The scope without which a grant cannot use the plan. */
const PLAN_USE = 'chatgpt.tokens.use.direct';

/** The resource every plan token is for: the public API. */
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';

/** The registration entrypoint: never saved, never used to exchange a code. */
const REGISTRATION_CLIENT = 'dynamic_agent_client';

/** The name the owner sees, and may edit, when registering. */
const AGENT_NAME = 'Ops Astro';

const AUTHORIZE_PATH = '/api/accounts/authorize';
const TOKEN_PATH = '/api/accounts/oauth/token';

/** The loopback port and path the sign-in answers to. */
export const SIGN_IN_PORT = 1455;
const CALLBACK = '/auth/callback';

/** How long the owner has to finish in the browser. */
const SIGN_IN_WAIT_MS = 5 * 60_000;

const ISSUED_ID = /^[\w-]{1,200}$/u;

export type SignInRefusal =
  | 'SIGN_IN_STATE_MISMATCH'
  | 'SIGN_IN_DECLINED'
  | 'SIGN_IN_REGISTRATION_INCOMPLETE'
  | 'SIGN_IN_EXCHANGE_FAILED'
  | 'SIGN_IN_PLAN_USE_NOT_GRANTED'
  | 'SIGN_IN_TIMED_OUT'
  | 'SIGN_IN_STORE_FAILED';

export interface SignInOptions {
  readonly issuer: string;
  readonly tokenFile: string;
  /** 0 picks a free port: tests only. */
  readonly port?: number;
  readonly timeoutMs?: number;
  /** Opens the sign-in address for the owner. */
  readonly open: (address: string) => void;
  /** Each line said to the owner: never a secret. */
  readonly say: (line: string) => void;
  readonly now?: () => number;
}

type Refused = { readonly ok: false; readonly code: SignInRefusal };

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/** This machine's host id, made once and kept beside the token file. */
function hostId(tokenFile: string): string {
  const file = join(dirname(tokenFile), 'chatgpt-host.json');
  try {
    const kept = (JSON.parse(readFileSync(file, 'utf8')) as { extAgentHostId?: unknown })
      .extAgentHostId;
    if (typeof kept === 'string' && /^urn:uuid:[0-9a-f-]{36}$/u.test(kept)) return kept;
  } catch {
    // None yet: made below.
  }
  const made = `urn:uuid:${randomUUID()}`;
  writeFileSync(file, JSON.stringify({ extAgentHostId: made }), { mode: 0o600 });
  return made;
}

/** One sign-in's fresh secrets and where it is going. */
interface Asking {
  readonly verifier: string;
  readonly state: string;
  readonly redirectUri: string;
  /** The saved client id of a later sign-in; none on the first, which registers. */
  readonly saved: string | undefined;
}

/** The authorize address the owner opens, with every parameter the flow publishes. */
function authorizeAddress(options: SignInOptions, asking: Asking): string {
  const address = new URL(AUTHORIZE_PATH, options.issuer);
  const parameters: Record<string, string> = {
    client_id: asking.saved ?? REGISTRATION_CLIENT,
    ...(asking.saved === undefined ? { agent_name_hint: AGENT_NAME } : {}),
    ext_agent_host_id: hostId(options.tokenFile),
    response_type: 'code',
    scope: CHATGPT_PLAN_SCOPES,
    resource: CHATGPT_PLAN_RESOURCE,
    redirect_uri: asking.redirectUri,
    state: asking.state,
    nonce: base64url(randomBytes(32)),
    code_challenge: base64url(createHash('sha256').update(asking.verifier).digest()),
    code_challenge_method: 'S256',
  };
  for (const [name, value] of Object.entries(parameters)) address.searchParams.set(name, value);
  return address.toString();
}

/** The callback's query, once, or the wait's end. */
async function answered(server: Server, timeoutMs: number): Promise<URLSearchParams | undefined> {
  return await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== CALLBACK) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Ops Astro: you can close this tab and return to the terminal.');
      clearTimeout(timer);
      resolve(url.searchParams);
    });
  });
}

/** The code and the client id to exchange it with, or why not. */
function judged(
  query: URLSearchParams,
  asking: Asking,
): { readonly code: string; readonly clientId: string } | Refused {
  if (query.get('state') !== asking.state) return { ok: false, code: 'SIGN_IN_STATE_MISMATCH' };
  const code = query.get('code');
  if (query.has('error') || code === null || code === '') {
    return { ok: false, code: 'SIGN_IN_DECLINED' };
  }
  const issued = asking.saved ?? query.get('client_id') ?? '';
  if (!ISSUED_ID.test(issued) || issued === REGISTRATION_CLIENT) {
    return { ok: false, code: 'SIGN_IN_REGISTRATION_INCOMPLETE' };
  }
  return { code, clientId: issued };
}

interface Granted {
  readonly access: string;
  readonly refresh: string;
  readonly expiresIn: number;
  readonly scopes: readonly string[];
}

/** The tokens the exchange answered, or undefined. */
async function exchanged(
  options: SignInOptions,
  asking: Asking,
  got: { readonly code: string; readonly clientId: string },
): Promise<Granted | undefined> {
  try {
    const answer = await fetch(new URL(TOKEN_PATH, options.issuer), {
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
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!answer.ok) return undefined;
    const body = (await answer.json()) as Record<string, unknown>;
    const { access_token: access, refresh_token: refresh, expires_in: expiresIn, scope } = body;
    if (typeof access !== 'string' || typeof refresh !== 'string') return undefined;
    if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      return undefined;
    }
    const scopes = typeof scope === 'string' ? scope.split(' ') : [];
    return { access, refresh, expiresIn, scopes };
  } catch {
    return undefined;
  }
}

/** The callback judged, the code exchanged and the tokens written under custody's lock. */
async function finished(
  options: SignInOptions,
  asking: Asking,
  query: URLSearchParams,
): Promise<{ readonly ok: true } | Refused> {
  const got = judged(query, asking);
  if ('ok' in got) return got;
  const granted = await exchanged(options, asking, got);
  if (granted === undefined) return { ok: false, code: 'SIGN_IN_EXCHANGE_FAILED' };
  if (!granted.scopes.includes(PLAN_USE)) {
    return { ok: false, code: 'SIGN_IN_PLAN_USE_NOT_GRANTED' };
  }
  const written = await withTokenLock(options.tokenFile, () => {
    writeTokenFile(options.tokenFile, {
      clientId: got.clientId,
      accessToken: granted.access,
      refreshToken: granted.refresh,
      expiresAt: (options.now ?? Date.now)() + granted.expiresIn * 1000,
    });
    return true;
  });
  return written === undefined ? { ok: false, code: 'SIGN_IN_STORE_FAILED' } : { ok: true };
}

export async function signIn(options: SignInOptions): Promise<{ readonly ok: true } | Refused> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? SIGN_IN_PORT, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const held = readTokenFile(options.tokenFile);
    const asking: Asking = {
      verifier: base64url(randomBytes(64)),
      state: base64url(randomBytes(32)),
      redirectUri: `http://127.0.0.1:${String(port)}${CALLBACK}`,
      saved: typeof held === 'string' ? undefined : held.clientId,
    };
    const opening = authorizeAddress(options, asking);
    const waiting = answered(server, options.timeoutMs ?? SIGN_IN_WAIT_MS);
    options.say('Opening the ChatGPT sign-in in your browser. If it does not open, visit:');
    options.say(opening);
    options.open(opening);
    const query = await waiting;
    if (query === undefined) return { ok: false, code: 'SIGN_IN_TIMED_OUT' };
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
