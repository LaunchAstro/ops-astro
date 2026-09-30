// SPDX-License-Identifier: AGPL-3.0-only
//
// The Vercel function entry (ticket S0-6, the Vercel re-plan). Vercel runs the
// API as a function: no port, no process of our own, so this file has none of
// `server.ts`'s `main`. It builds the same served app, `composeApi`, from the
// function's environment and hands it each request.
//
// **Only the environment's own host is served.** Every deployment also answers
// at a generated address of its own, and a promotion leaves the previous one
// running. `SERVED_HOST` names the one host this environment answers on; a
// request naming any other, in its Host header or its own URL, a forwarding
// header notwithstanding, is refused 421 before anything is read. So once the alias has moved, the deployment it moved
// from serves nothing.
//
// What `main` does that a function does not: the loopback identity route, the
// live channel's LISTEN, restart recovery and the sweeper. Those belong to a
// long-running process, the worker (re-plan, section 11).
//
// **No admin login (G2).** The business key, the one read before tenancy, is
// read on `DATABASE_LOOKUP_URL`, a login in the lookup identity (0046) that
// reads business ids and keys and nothing else; `/api/health` runs on it too.
// Unset, the runtime login stands in and every business key is refused.
// The entry refuses to start with `DATABASE_ADMIN_URL` in its environment, so
// a breach of the function's settings never holds a login that reads every
// business.
//
// **Alerts go to the outbox (S0-2).** A function has no route to the error
// sink and no memory another instance shares: a deployment (`OPS_ENVIRONMENT`
// set) appends each signal and error to `ops.api_events` on its own runtime
// login, scopes keyed by `ALERT_SCOPE_KEY`, and the environment's forwarder
// counts and sends (`apps/forwarder`). The sink's DSN is the forwarder's, so
// the entry refuses to start beside it.

import { join } from 'node:path';
import { connect, connectAsAdmin, connectOutbox } from '../../packages/core-records/src/index.ts';
import { crashSeamProblem, runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { createOutboxAlerts, scopeKey } from './alerts/outbox.ts';
import type { Alerts } from './alerts/sink.ts';
import { keySetUrlFor } from './auth/supabase.ts';
import { composeApi } from './server.ts';

type Settings = Readonly<Record<string, string | undefined>>;

const ROOT = join(import.meta.dirname, '..', '..');
/** A bare host name: no scheme, path, port or trailing dot. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;

/**
 * The function's request handler, built from its settings. A problem throws,
 * naming the setting and never its value, so the function does not start.
 */
export function createFunctionHandler(settings: Settings): (request: Request) => Promise<Response> {
  const seam = crashSeamProblem(settings);
  if (seam !== undefined) throw new Error(seam);
  const required = (name: string): string => {
    const value = settings[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set.`);
    return value;
  };
  const servedHost = required('SERVED_HOST').toLowerCase();
  if (!HOST.test(servedHost)) throw new Error('SERVED_HOST is not a bare host name.');
  const databaseUrl = required('DATABASE_URL');
  // Without a lookup login the runtime one stands in: it may not take the
  // lookup identity, so every key read is refused, and health still measures.
  const lookupUrl = settings['DATABASE_LOOKUP_URL'] || databaseUrl;
  const issuer = required('GOTRUE_URL');
  const keySetUrl = keySetUrlFor(settings['SUPABASE_KEY_SET_URL'] ?? '', issuer);
  if (keySetUrl === undefined) {
    throw new Error(
      'SUPABASE_KEY_SET_URL may name a loopback key set only, for a loopback issuer.',
    );
  }
  // The keyring from the settings alone: without them `runtimeKeys` falls back
  // to creating a local key file, and a function has none to share.
  required('DELEGATION_CREDENTIAL_KEY_ID');
  required('DELEGATION_CREDENTIAL_KEYS');
  const keys = runtimeKeys(settings);
  if (!keys.delegation.ok) {
    throw new Error(`delegation credential keys: ${keys.delegation.problem}`);
  }
  const alerts = outboxAlerts(settings, databaseUrl, required);

  const { app } = composeApi({
    database: connect(databaseUrl, { source: 'runtime' }),
    admin: connectAsAdmin(lookupUrl, { source: 'lookup' }),
    signIn: { issuer, keySetUrl },
    keys,
    ...(alerts === undefined ? {} : { alerts }),
  });

  return async (request) => {
    const hosts = [request.headers.get('host') ?? '', new URL(request.url).host];
    if (hosts.some((host) => host.toLowerCase() !== servedHost)) {
      return new Response(null, { status: 421, headers: { 'cache-control': 'private, no-store' } });
    }
    return await app.fetch(request);
  };
}

/** A deployment's alerts, on the outbox; none where neither setting is given (the local world). */
function outboxAlerts(
  settings: Settings,
  databaseUrl: string,
  required: (name: string) => string,
): Alerts | undefined {
  const where = settings['OPS_ENVIRONMENT'] ?? '';
  if (where === '' && (settings['ALERT_SCOPE_KEY'] ?? '') === '') return undefined;
  if (where !== 'staging' && where !== 'production') {
    throw new Error('OPS_ENVIRONMENT must be staging or production.');
  }
  const key = scopeKey(required('ALERT_SCOPE_KEY'));
  const outbox = connectOutbox(databaseUrl, { source: 'runtime' });
  const release = settings['OPS_RELEASE'];
  return createOutboxAlerts({ outbox, key, where, root: ROOT, ...(release ? { release } : {}) });
}

let handler: ((request: Request) => Promise<Response>) | undefined;

/** The admin login, the sink's key and the backup and restore credentials: the M5's and the operator's. */
const HELD_ELSEWHERE = [
  'DATABASE_ADMIN_URL',
  'OPS_ERROR_SINK_DSN',
  'BACKUP_SOURCE_URL',
  'BACKUP_RETENTION_URL',
  'BACKUP_STORE_URL',
  'RESTORE_STORE_URL',
  'RESTORE_KEY_FILE',
];

/** Vercel's Node.js function signature, one export per method: built on first use. */
async function handle(request: Request): Promise<Response> {
  const held = HELD_ELSEWHERE.filter((name) => (process.env[name] ?? '') !== '');
  if (held.length > 0) {
    throw new Error(
      `${held.join(', ')} set: the function never holds the admin login, the sink key or a backup credential.`,
    );
  }
  handler ??= createFunctionHandler(process.env);
  return await handler(request);
}

export {
  handle as DELETE,
  handle as GET,
  handle as HEAD,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
