// SPDX-License-Identifier: AGPL-3.0-only
//
// A GitHub App's call (#1793): custody holds only the App's private key and,
// for each party, the one repository it may reach. A call names its party;
// custody finds that party's binding and refuses, before anything is sent,
// a call whose path is no route custody sends as written, or names any other
// repository, or the same one spelt otherwise. Admitted, custody signs a ten-minute App token and asks the
// App's installation for a token restricted to that one repository, with
// Contents and Pull requests and nothing more. The answer must name that
// repository alone and expire in the future, or nothing is sent with it.
// The minted token carries this one call and is then dropped: none is kept,
// so none outlives its expiry, and none is ever written to a log or passed
// back. The token request goes to the destination's own origin, through the
// same checked egress as the call itself.
//
// Custody's process loads this file, so it imports no connector or database code.

import { createPrivateKey, sign } from 'node:crypto';
import type { AppBinding, GithubApp, Presentable, StoredCredential } from './credentials.ts';
import { send, type Destination, type OutboundRequest } from './egress.ts';
import { pathAllowed } from './egress-routes.ts';

/**
 * A call's request, naming the party an App call is for: that picks the one
 * repository it may reach.
 */
export type PartyRequest = OutboundRequest & { readonly party?: string };

/** The repository a source call's path names, `owner/name`, as written. */
function repositoryOf(path: string): string | undefined {
  const match = /^\/repos\/([^/?#]+)\/([^/?#]+)(?:[/?]|$)/u.exec(path);
  return match === null ? undefined : `${match[1] ?? ''}/${match[2] ?? ''}`;
}

/** The call's party binding when its path names that party's repository byte for byte. */
function bindingFor(app: GithubApp, request: PartyRequest): AppBinding | undefined {
  const binding = app.bindings.find((one) => one.party === request.party);
  return binding !== undefined && repositoryOf(request.path) === binding.repository
    ? binding
    : undefined;
}

const encoded = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** The App's own token: RS256, issued a minute back for clock drift, good for ten minutes in all. */
function appToken(app: GithubApp, key: string, now: number): string {
  const issued = Math.floor(now / 1000) - 60;
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: issued, exp: issued + 600, iss: app.id })}`;
  const signature = sign('sha256', Buffer.from(unsigned), createPrivateKey(key));
  return `${unsigned}.${signature.toString('base64url')}`;
}

const MINT_LIMITS = { timeoutMs: 10_000, maxResponseBytes: 65_536 } as const;
const TOKEN = /^[!-~]{8,512}$/u;

/** The minted token if the answer is one for exactly this repository, still in date. */
function tokenOf(body: string, repository: string, now: number): string | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return undefined;
  }
  const { token, expires_at: expires, repositories } = (answer ?? {}) as Record<string, unknown>;
  const only = Array.isArray(repositories) && repositories.length === 1 ? repositories[0] : null;
  const named = (only as Record<string, unknown> | null)?.['full_name'];
  if (typeof token !== 'string' || !TOKEN.test(token) || named !== repository) return undefined;
  return typeof expires === 'string' && Date.parse(expires) > now ? token : undefined;
}

/**
 * A token minted for this one call, on the binding's installation and
 * repository, as the call presents it; undefined when the App gave none.
 */
async function mintFor(
  app: GithubApp,
  key: string,
  binding: AppBinding,
  destination: Destination,
  now: () => number = Date.now,
): Promise<Presentable | undefined> {
  const path = `/app/installations/${String(binding.installation)}/access_tokens`;
  const name = binding.repository.split('/')[1];
  // The token request alone: no route of the call's, and a POST to this one path.
  const { key: at, origin, headers } = destination;
  const minting: Destination = { key: at, origin, ...(headers && { headers }), posts: [path] };
  const outcome = await send(
    new Map([[destination.key, minting]]),
    {
      destination: destination.key,
      path,
      method: 'POST',
      body: JSON.stringify({
        repositories: [name],
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
      ...MINT_LIMITS,
    },
    { header: 'authorization', scheme: 'bearer', value: appToken(app, key, now()) },
  );
  if (!outcome.ok || outcome.status !== 201) return undefined;
  const token = tokenOf(outcome.body, binding.repository, now());
  return token === undefined
    ? undefined
    : { header: 'authorization', scheme: 'bearer', value: token };
}

/**
 * How a call on an App entry is carried: the token minted for it alone, or
 * why nothing may be sent. Both refusals come before anything reaches the
 * repository, and an unbound repository before anything leaves custody.
 */
export async function carriedByApp(
  credential: StoredCredential,
  request: PartyRequest,
  destinations: ReadonlyMap<string, Destination>,
): Promise<
  | Presentable
  | 'CUSTODY_REQUEST_MALFORMED'
  | 'CUSTODY_REPOSITORY_NOT_BOUND'
  | 'CUSTODY_TOKEN_NOT_MINTED'
> {
  const { app } = credential;
  const destination = destinations.get(request.destination);
  // Only a path custody would send as written: no step or escape can take it to another repository.
  if (destination === undefined || !pathAllowed(destination, request.method, request.path)) {
    return 'CUSTODY_REQUEST_MALFORMED';
  }
  const binding = app === undefined ? undefined : bindingFor(app, request);
  if (app === undefined || binding === undefined) return 'CUSTODY_REPOSITORY_NOT_BOUND';
  const token = await mintFor(app, credential.value, binding, destination).catch(() => null);
  return token ?? 'CUSTODY_TOKEN_NOT_MINTED';
}
