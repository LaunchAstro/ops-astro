// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/password/set` (C40, link use): the reset page sends the new
// password with the bearer of the recovery session the reset link opened,
// and the password is set (`setPasswordByRecovery`). Outside the business
// prefix, with no person grant: the recovery session is the authority. The
// bearer only, never a cookie, so there is no ambient credential for another
// site to ride, and a recovery session is never traded for one.
//
// Answers carry a code and nothing else, and nothing is logged: 200
// `{ signedOutAtProvider }`; 401 `RESET_LINK_INVALID` for every session that
// is not a live recovery session of a mapped login (none, forged, expired,
// spent, an ordinary sign-in); 400 `PASSWORD_INVALID` for a password out of
// bounds; 503 `RESET_UNAVAILABLE` when the provider failed or answered
// wrongly, nothing changed here.
//
// Mounted, with the ask below, by the composition root when the login
// provider's Send Email hook is configured (`AUTH_EMAIL_HOOK_SECRET`).

import { isIPv6 } from 'node:net';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  requestPasswordReset,
  setPasswordByRecovery,
  type PasswordProvider,
} from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import { bearerOf } from './auth/session.ts';

export const PASSWORD_SET_PATH = '/api/password/set';
export const PASSWORD_RESET_PATH = '/api/password/reset';

/** Asks one process works on at once; past it an ask is dropped, answered alike. */
export const RESET_IN_FLIGHT = 4;

/** A password and room for its JSON, no more. */
const SET_MAX_BYTES = 1024;

export interface PasswordSetOptions {
  /** The deployment's businesses, the ones the login is looked for in. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The provider's calls with the person's own token. */
  readonly provider: PasswordProvider;
  readonly verify: Verifier;
}

const STATUS = { RESET_LINK_INVALID: 401, PASSWORD_INVALID: 400, RESET_UNAVAILABLE: 503 } as const;

/** The body's password, when it is one JSON object holding it as a string. */
async function passwordOf(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { password } = body as Record<string, unknown>;
    return typeof password === 'string' ? password : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The request's client address, as the API reads it elsewhere (`/api/identity`):
 * the socket's peer that `@hono/node-server` hands over, never a forwarded
 * header a client can write. An IPv4 mapped into IPv6 counts as the IPv4, and
 * an IPv6 client by its /64, the least a host is handed. With none, every
 * such ask shares one source.
 */
function sourceOf(env: unknown): string {
  const peer = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    ?.socket?.remoteAddress;
  if (typeof peer !== 'string' || peer === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(peer);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!isIPv6(peer)) return peer;
  const [head = '', tail] = peer.split('%')[0]?.split('::') ?? [];
  const before = head === '' ? [] : head.split(':');
  const after = tail === undefined || tail === '' ? [] : tail.split(':');
  // A dotted IPv4 at the end fills two groups.
  const filled = before.length + after.length + (peer.includes('.') ? 1 : 0);
  const groups =
    tail === undefined ? before : [...before, ...Array(8 - filled).fill('0'), ...after];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** Mount the route on `server`, the way `composeApi` mounts the hooks. */
export function mountPasswordSet(
  server: Hono,
  database: Database,
  options: PasswordSetOptions,
): void {
  const tooLarge = bodyLimit({
    maxSize: SET_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_TOO_LARGE' }, 413),
  });
  server.post(PASSWORD_SET_PATH, tooLarge, async (context) => {
    try {
      const accessToken = bearerOf(context.req);
      const presented = accessToken === undefined ? undefined : await options.verify(context.req);
      if (accessToken === undefined || typeof presented !== 'object') {
        return context.json({ code: 'RESET_LINK_INVALID' }, 401);
      }
      const password = await passwordOf(context.req.raw);
      if (password === undefined) return context.json({ code: 'RESET_MALFORMED' }, 400);
      const result = await setPasswordByRecovery(
        database,
        await options.businesses(),
        options.provider,
        { presented, accessToken, password },
      );
      if (result.ok) return context.json({ signedOutAtProvider: result.signedOutAtProvider }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'RESET_FAULT' }, 503);
    }
  });
}

/**
 * `POST /api/password/reset` (C40, the ask): `{ address }`, no sign-in. The
 * address goes to the login provider through custody (`requestPasswordReset`)
 * after the answer is given, unless the client address or the address is past
 * its limit, or `RESET_IN_FLIGHT` asks are already being worked on, so every
 * request, for a known address, an unknown one or none, limited, dropped or
 * not, is answered 200 `{}` at once, and its time says nothing either. A
 * failure is nobody's to hear, and nothing is logged.
 */
export function mountPasswordReset(server: Hono, database: Database, broker: Broker): void {
  const tooLarge = bodyLimit({
    maxSize: SET_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_TOO_LARGE' }, 413),
  });
  let inFlight = 0;
  // The peer is read before the body limit reads the body, while the socket is surely there.
  const sources = new WeakMap<object, string>();
  const peerFirst: MiddlewareHandler = async (context, next) => {
    sources.set(context, sourceOf(context.env));
    await next();
  };
  server.post(PASSWORD_RESET_PATH, peerFirst, tooLarge, async (context) => {
    const source = sources.get(context) ?? 'unknown';
    let address: unknown;
    try {
      const body: unknown = await context.req.json();
      address =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['address']
          : undefined;
    } catch {
      address = undefined;
    }
    // One held database connection serves the whole API: past the cap, the ask is dropped.
    if (inFlight < RESET_IN_FLIGHT) {
      inFlight += 1;
      void requestPasswordReset(database, broker, { address, source })
        .catch(() => {})
        .finally(() => {
          inFlight -= 1;
        });
    }
    return context.json({}, 200);
  });
}
