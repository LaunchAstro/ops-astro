// SPDX-License-Identifier: AGPL-3.0-only
//
// The Vercel function entry (ticket S0-6, the Vercel re-plan). Vercel runs the
// API as a function: no port, no process of our own, so this file has none of
// `server.ts`'s `main`. It builds the same served app, `composeApi`, from the
// function's environment and hands it each request.
//
// What `main` does that a function does not: the loopback identity route, the
// live channel's LISTEN, restart recovery and the sweeper. Those belong to a
// long-running process, the worker (re-plan, section 11).

import { join } from 'node:path';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { crashSeamProblem, runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { createAlerts, sinkFrom } from './alerts/sink.ts';
import { keySetUrlFor } from './auth/supabase.ts';
import { composeApi } from './server.ts';

type Settings = Readonly<Record<string, string | undefined>>;

const ROOT = join(import.meta.dirname, '..', '..');
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
  const databaseUrl = required('DATABASE_URL');
  const adminUrl = required('DATABASE_ADMIN_URL');
  const issuer = required('GOTRUE_URL');
  const keySetUrl = keySetUrlFor(settings['SUPABASE_KEY_SET_URL'] ?? '', issuer);
  if (keySetUrl === undefined) {
    throw new Error(
      'SUPABASE_KEY_SET_URL may name a loopback key set only, for a loopback issuer.',
    );
  }
  const keys = runtimeKeys(settings);
  if (!keys.delegation.ok) {
    throw new Error(`delegation credential keys: ${keys.delegation.problem}`);
  }
  const sink = sinkFrom(settings);

  const { app } = composeApi({
    database: connect(databaseUrl, { source: 'runtime' }),
    admin: connectAsAdmin(adminUrl, { source: 'admin' }),
    signIn: { issuer, keySetUrl },
    keys,
    ...(sink === undefined ? {} : { alerts: createAlerts({ ...sink, root: ROOT }) }),
  });

  return async (request) => {
    return await app.fetch(request);
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

/** Vercel's Node.js function signature, one export per method: built on first use. */
async function handle(request: Request): Promise<Response> {
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
