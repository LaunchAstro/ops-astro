// SPDX-License-Identifier: AGPL-3.0-only
//
// The composition root. The only place that reads the environment, opens a
// connection, chooses an authentication adapter and binds a port.
//
// Everything the boundary needs is handed to it here, which is what makes the
// claims in `app.ts` checkable: there is exactly one construction of the
// verifier, one business resolver and one database, and they are visible in
// one file rather than spread across the modules that use them.
//
// Two decisions worth seeing.
//
// **`/api/health` reports what it measured.** It runs a statement and answers
// from the result, so an unreachable database is a 503 saying so rather than a
// 200 that a caller has to disbelieve. Checklist case B7 needs the difference
// between unavailable and denied to be real at the source, not painted on in
// the browser.
//
// **The business key is resolved on the administrative connection, and only
// the key.** The tenancy root is behind forced row security keyed on the
// setting the serving transaction has not set yet, so the mapping from a path
// segment to a business identifier cannot be read by the application role: it
// is the one lookup that has to precede tenancy. It reads one column of one
// row by key and answers nothing else, and every statement after it runs
// through `withBusiness` like everything else in the slice.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  connect,
  connectAsAdmin,
  isBusinessId,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createApi, type AgentExecutor, type ReadExecutor } from './app.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { delegationCredentialKeys } from '../../packages/core-records/src/commands/runtime-config.ts';
import { createSupabaseVerifier } from './auth/supabase.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `KEY=value` lines, comments and blanks ignored. A missing file is empty. */
export function readEnvFile(file: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    values[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return values;
}

/** The real environment wins, so a shell can override a local file. */
export function localEnvironment(): Readonly<Record<string, string | undefined>> {
  return {
    ...readEnvFile(join(ROOT, '.local', 'db.env')),
    ...readEnvFile(join(ROOT, '.local', 'auth.env')),
    // The decision signing key. Written by `scripts/local-seed.mjs` into a
    // gitignored file of its own, beside the two the database and GoTrue
    // scripts write, because it is a deployment secret rather than a
    // connection string and it has no business in either of theirs.
    ...readEnvFile(join(ROOT, '.local', 'gate.env')),
    // The delegation credential keyring, in a gitignored file of its own for
    // the same reason, and never the gate key or the JWT secret.
    ...readEnvFile(join(ROOT, '.local', 'delegation.env')),
    ...process.env,
  };
}

/**
 * The business key to its identifier, cached after the first answer.
 *
 * The cache holds successes only. A key that is not there is asked again next
 * time, so a business created while the server is up is reachable without a
 * restart, and a wrong key cannot be turned into a cheap probe for one that
 * is.
 */
export function createBusinessResolver(
  admin: AdminConnection,
): (businessKey: string) => Promise<string | undefined> {
  const known = new Map<string, string>();

  return async function resolveBusiness(businessKey: string): Promise<string | undefined> {
    if (businessKey === '') return undefined;
    const cached = known.get(businessKey);
    if (cached !== undefined) return cached;

    const rows = await admin.execute<{ id: string }>(
      'select id from public.businesses where key = $1',
      [businessKey],
    );
    const id = rows[0]?.id;
    if (id === undefined || !isBusinessId(id)) return undefined;
    known.set(businessKey, id);
    return id;
  };
}

/**
 * SLICE-DATA's read executor, if it has landed.
 *
 * Imported dynamically because the module is another lane's and does not exist
 * in every checkout of this branch. A missing module is not an error here: the
 * boundary already answers `DEPENDENCY_NOT_LANDED` for a declared read with no
 * executor, which is the truthful answer and the one the surface already uses
 * for a command whose part has not been built.
 */
export async function loadReadExecutor(): Promise<ReadExecutor | undefined> {
  // The specifier is assembled rather than written as a literal so that a
  // checkout without the module typechecks: the compiler cannot resolve a path
  // it cannot see, and a missing optional dependency is not a type error.
  const specifier = ['..', '..', 'packages', 'core-records', 'src', 'reads', 'execute.ts'].join(
    '/',
  );
  try {
    const module: unknown = await import(specifier);
    const execute = (module as { executeRead?: unknown }).executeRead;
    return typeof execute === 'function' ? (execute as ReadExecutor) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const environment = localEnvironment();
  const port = Number(environment['API_PORT'] ?? 8790);
  const databaseUrl = environment['DATABASE_URL'];
  const adminUrl = environment['DATABASE_ADMIN_URL'];
  const secret = environment['SUPABASE_JWT_SECRET'];

  for (const [name, value] of [
    ['DATABASE_URL', databaseUrl],
    ['DATABASE_ADMIN_URL', adminUrl],
    ['SUPABASE_JWT_SECRET', secret],
  ] as const) {
    if (value === undefined || value === '') {
      console.error(`api: ${name} is not set. Run scripts/local/db-up.sh and auth-up.sh first.`);
      process.exit(1);
    }
  }

  const database = connect(databaseUrl as string, { source: 'runtime' });
  const admin = connectAsAdmin(adminUrl as string, { source: 'admin' });
  const executeRead = await loadReadExecutor();
  // The signing key is a process fact, read by `commands/runtime-config.ts`
  // from the environment rather than passed down through every caller. The
  // composition root is where a deployment's environment is assembled, so this
  // is where the file the seed wrote becomes one.
  for (const name of [
    'GATE_SIGNING_KEY_ID',
    'GATE_SIGNING_SECRET',
    'DELEGATION_CREDENTIAL_KEY_ID',
    'DELEGATION_CREDENTIAL_KEYS',
  ] as const) {
    const value = environment[name];
    if (value !== undefined && value !== '') process.env[name] = value;
  }
  // Checked at boot so a malformed keyring stops the server with its reason,
  // rather than serving until the first agent pickup refuses. The problem names
  // the setting, never a key's bytes.
  const credentialKeys = delegationCredentialKeys();
  if (!credentialKeys.ok) {
    console.error(`api: delegation credential keys: ${credentialKeys.problem}`);
    process.exit(1);
  }

  const server = new Hono();

  // Measured, not assumed. `reachable` is the result of a statement that ran.
  server.get('/api/health', async (context) => {
    let reachable = false;
    let detail = '';
    try {
      await admin.execute('select 1 as ok');
      reachable = true;
    } catch (cause) {
      detail = cause instanceof Error ? cause.message : 'unknown';
    }
    return context.json(
      {
        ok: reachable,
        database: reachable ? 'reachable' : 'unreachable',
        reads: executeRead === undefined ? 'not-landed' : 'mounted',
        detail,
      },
      reachable ? 200 : 503,
    );
  });

  server.route(
    '/',
    createApi({
      database,
      verify: createSupabaseVerifier({ secret: secret as string }),
      resolveBusiness: createBusinessResolver(admin),
      ...(executeRead === undefined ? {} : { executeRead }),
      executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
    }),
  );

  // A fault reaching here is a fault, not a refusal, and it is reported as one
  // rather than as a 404 that reads like a missing route or a 403 that reads
  // like a decision. The message is not echoed: a message may carry a value.
  server.onError((cause, context) => {
    console.error('api: unhandled', cause instanceof Error ? cause.message : cause);
    return context.json({ code: 'SERVICE_UNAVAILABLE', names: [], fixes: [RETRY] }, 503);
  });

  serve({ fetch: server.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.log(`api: listening on http://127.0.0.1:${info.port}`);
    console.log(`api: reads ${executeRead === undefined ? 'not landed' : 'mounted'}`);
  });

  const stop = (): void => {
    void Promise.allSettled([database.close(), admin.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const RETRY =
  'The service could not complete the request. Retry; if it persists, check /api/health.';

await main();
