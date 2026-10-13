// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's one sign-in to the ChatGPT plan, run by the owner on the
// owner's machine (#1620, `docs/local/chatgpt-plan.md`): the loopback PKCE
// flow. It makes a fresh verifier, its S256 challenge and a state, listens on
// this machine's loopback only, and opens the sign-in address in the owner's
// browser. The answer must come back to loopback with the same state, or
// nothing is exchanged. The code is exchanged with the verifier, and the
// tokens are written to custody's token file, owner-only, renamed into place
// (`plan-token.ts`). It reads no other sign-in on the machine, and says
// nothing secret: no token, code or verifier.
//
// The owner runs it as `chatgpt-sign-in-command.ts`.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { withTokenLock, writeTokenFile } from '../../packages/core-custody/src/plan-token.ts';

/** The plan's scopes, as its open-source token sharing grants them. */
export const CHATGPT_PLAN_SCOPES = 'offline_access resource.invoke chatgpt.tokens.use.direct';

/** The loopback port and path the sign-in answers to. */
export const SIGN_IN_PORT = 1455;
const CALLBACK = '/auth/callback';

/** How long the owner has to finish in the browser. */
const SIGN_IN_WAIT_MS = 5 * 60_000;

export type SignInRefusal =
  | 'SIGN_IN_STATE_MISMATCH'
  | 'SIGN_IN_DECLINED'
  | 'SIGN_IN_EXCHANGE_FAILED'
  | 'SIGN_IN_TIMED_OUT'
  | 'SIGN_IN_STORE_FAILED';

export interface SignInOptions {
  readonly issuer: string;
  readonly clientId: string;
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

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/** The sign-in address the owner opens: the plan's scopes, the S256 challenge and the state. */
function authorizeAddress(
  options: SignInOptions,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const asking = new URL('/oauth/authorize', options.issuer);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: redirectUri,
    scope: CHATGPT_PLAN_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })) {
    asking.searchParams.set(name, value);
  }
  return asking.toString();
}

/** The callback's query, once, or the wait's end. */
async function answered(server: Server, timeoutMs: number): Promise<URLSearchParams | undefined> {
  return await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
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

/** The tokens the exchange answered, or undefined. */
async function exchanged(
  options: SignInOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ access: string; refresh: string; expiresIn: number } | undefined> {
  try {
    const answer = await fetch(`${options.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: options.clientId,
        code_verifier: verifier,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!answer.ok) return undefined;
    const body = (await answer.json()) as Record<string, unknown>;
    const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = body;
    if (typeof access !== 'string' || typeof refresh !== 'string') return undefined;
    if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      return undefined;
    }
    return { access, refresh, expiresIn };
  } catch {
    return undefined;
  }
}

export async function signIn(
  options: SignInOptions,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: SignInRefusal }> {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? SIGN_IN_PORT, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const redirectUri = `http://localhost:${String(port)}${CALLBACK}`;
    const asking = authorizeAddress(options, redirectUri, challenge, state);
    const waiting = answered(server, options.timeoutMs ?? SIGN_IN_WAIT_MS);
    options.say('Opening the ChatGPT sign-in in your browser. If it does not open, visit:');
    options.say(asking);
    options.open(asking);
    const query = await waiting;
    if (query === undefined) return { ok: false, code: 'SIGN_IN_TIMED_OUT' };
    if (query.get('state') !== state) return { ok: false, code: 'SIGN_IN_STATE_MISMATCH' };
    const code = query.get('code');
    if (query.has('error') || code === null || code === '') {
      return { ok: false, code: 'SIGN_IN_DECLINED' };
    }
    const tokens = await exchanged(options, code, verifier, redirectUri);
    if (tokens === undefined) return { ok: false, code: 'SIGN_IN_EXCHANGE_FAILED' };
    // Under custody's lock, so a refresh in flight cannot overwrite the new pair.
    const written = await withTokenLock(options.tokenFile, () => {
      writeTokenFile(options.tokenFile, {
        clientId: options.clientId,
        accessToken: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: (options.now ?? Date.now)() + tokens.expiresIn * 1000,
      });
      return true;
    });
    if (written === undefined) return { ok: false, code: 'SIGN_IN_STORE_FAILED' };
    options.say('Signed in. The plan token is in custody on this machine only.');
    return { ok: true };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
