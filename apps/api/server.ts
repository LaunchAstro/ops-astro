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
// The file is two halves. `composeApi` is the wiring and nothing else: given
// the connections and the secret it builds the served app, fault mapping
// included, and touches no environment, socket or process. `main` reads the
// environment, runs restart recovery, calls `composeApi` and listens, and runs
// only when this file is the process's entry, so a test imports the same
// wiring the server listens with rather than keeping a copy of it.
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

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import {
  connect,
  connectAsAdmin,
  isBusinessId,
  KEY_FILE_VARIABLE,
  readEnvFile,
} from '../../packages/core-records/src/index.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { createApi, type ReadExecutor } from './app.ts';
import {
  executeAgentCommand,
  describeFault,
  executeCommand,
  executeRead as readExecutor,
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/index.ts';
import { runtimeKeys, withRuntimeKeys } from '../../packages/core-runtime/src/index.ts';
import type { RuntimeKeys } from '../../packages/core-runtime/src/index.ts';
import { createGoTrueFactors } from './auth/factors.ts';
import { createGoTrueLogins } from './auth/logins.ts';
import { createSupabaseVerifier } from './auth/supabase.ts';
import {
  describeRecovered,
  parseRecoveryScope,
  recoverDeployment,
  RECOVERY_SCOPE_SETTING,
} from './recovery-entry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The real environment wins, so a shell can override a local file.
 *
 * A key file named in the real environment is not shadowed by the checkout's
 * keyring: with `DELEGATION_CREDENTIAL_KEY_FILE` set, `.local/delegation.env`
 * is not read. Copied into the process environment its two settings would be
 * explicit configuration, and `configuredCredentialKeys` never consults the
 * named file once either is present (`credential-keys.ts`).
 */
export function localEnvironment(): Readonly<Record<string, string | undefined>> {
  const keyFileNamed = (process.env[KEY_FILE_VARIABLE] ?? '') !== '';
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
    ...(keyFileNamed ? {} : readEnvFile(join(ROOT, '.local', 'delegation.env'))),
    // The deployment's businesses for restart recovery, `RECOVERY_BUSINESS_KEYS`.
    // Deployment configuration rather than a secret, in a file of its own so the
    // database script that rewrites `db.env` cannot drop it.
    ...readEnvFile(join(ROOT, '.local', 'recovery.env')),
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
 *
 * **A key two businesses hold names neither.** Since 0027
 * (`businesses_key_global_idx`) storage refuses a second business under a
 * held key. The lookup still reads up to two rows and answers the unresolved
 * refusal for more than one, rather than serving and caching whichever row
 * came back first, as the backstop for a database below 0027. That refusal is
 * not cached, so the key resolves again once only one business holds it.
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
      'select id from public.businesses where key = $1 limit 2',
      [businessKey],
    );
    if (rows.length !== 1) return undefined;
    const id = rows[0]?.id;
    if (id === undefined || !isBusinessId(id)) return undefined;
    known.set(businessKey, id);
    return id;
  };
}

/** What `composeApi` wires. Every value is one `main` read or opened. */
export interface ApiConfig {
  /** The application role's connection, the one every request runs on. */
  readonly database: Database;
  /** The owner's connection, used for the business key and `/api/health` only. */
  readonly admin: AdminConnection;
  /** The HS256 secret the Supabase adapter verifies bearers with. */
  readonly secret: string;
  /** The issuer every bearer must name: the GoTrue URL, `GOTRUE_URL`. */
  readonly issuer: string;
  /** The signing key and delegation keyring `main` read, never put in `process.env`. */
  readonly keys: RuntimeKeys;
  /**
   * The read half of the surface. Absent means `reads/execute.ts`, imported
   * statically, so a module that fails to load stops the server rather than
   * turning every read into `DEPENDENCY_NOT_LANDED`. A test hands in its own
   * to reach the fault branch.
   */
  readonly executeRead?: ReadExecutor;
}

export interface ComposedApi {
  /** The served app: `/api/health`, the boundary, and the fault mapping. */
  readonly app: Hono;
  /** The sign-in provider's calls for an ended login (C58), for the retry. */
  readonly logins: LoginProvider;
  /**
   * The app's own business resolver. Restart recovery resolves its keys
   * through it before the port is bound, so the recovery and the requests that
   * follow share one lookup and one cache.
   */
  readonly resolveBusiness: (businessKey: string) => Promise<string | undefined>;
}

/**
 * The served app, wired. No environment, no socket, no process: the caller
 * owns those, which is what lets a test build this twice over one database.
 */
export function composeApi(config: ApiConfig): ComposedApi {
  const { database, admin } = config;
  const executeRead = config.executeRead ?? readExecutor;
  const logins = goTrueLogins(config.secret, config.issuer);
  const resolveBusiness = createBusinessResolver(admin);
  const server = new Hono();
  // This app's keys, for this request only: no other composition can replace them.
  server.use(async (_context, next) => await withRuntimeKeys(config.keys, next));

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
        reads: 'mounted',
        detail,
      },
      reachable ? 200 : 503,
    );
  });

  server.route(
    '/',
    createApi({
      database,
      verify: createSupabaseVerifier({ secret: config.secret, issuer: config.issuer }),
      resolveBusiness,
      executeRead,
      executeCommand,
      executeAgentCommand,
      // The provider GoTrue is: the one destination its factor calls reach.
      factors: createGoTrueFactors({ baseUrl: config.issuer }),
      logins,
    }),
  );

  // A fault reaching here is a fault, not a refusal, and it is reported as one
  // rather than as a 404 that reads like a missing route or a 403 that reads
  // like a decision. The message is neither echoed nor logged: a message may
  // carry a value. The log gets a bounded code and a reference.
  server.onError((cause, context) => {
    const reference = randomUUID();
    console.error(
      `api: unhandled fault ${describeFault(cause)} (reference ${reference}): the request ` +
        'could not be completed. Its contents and the fault text are left out of this log.',
    );
    if ('getResponse' in cause) return cause.getResponse();
    return context.json({ code: 'SERVICE_UNAVAILABLE', names: [], fixes: [RETRY] }, 503);
  });

  return { app: server, logins, resolveBusiness };
}

/** How often the server retries the provider steps an access ending owes (C58). */
export const ACCESS_ENDING_RETRY_SECONDS = 60;

/**
 * GoTrue's calls for an ended login, with the two bearers they need minted
 * here from the secret every session is already verified with: an
 * administrative one for the deactivation, and one naming the login's own
 * subject for its global sign-out. Each lives a minute and is never stored.
 */
function goTrueLogins(secret: string, issuer: string): LoginProvider {
  const mint = async (claims: Readonly<Record<string, unknown>>): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return await sign(
      { ...claims, aud: 'authenticated', iss: issuer, iat: now, exp: now + 60 },
      secret,
      'HS256',
    );
  };
  return createGoTrueLogins({
    baseUrl: issuer,
    adminToken: async () => await mint({ role: 'service_role' }),
    subjectToken: async (subject) => await mint({ sub: subject, role: 'authenticated' }),
  });
}

/**
 * One retry pass (C58): every business with an access ending that still owes
 * the provider a step, each settled under its own tenancy. The owner's
 * connection reads business ids and nothing else; the endings themselves are
 * read and stamped on the application connection, inside the business.
 * Answers how many endings still owe a step.
 */
export async function retryAccessEndings(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  /** A test's shorter claim; the settle's own otherwise. */
  claimSeconds?: number,
): Promise<number> {
  const rows = await admin.execute<{ readonly business_id: string }>(
    `select distinct business_id from public.access_endings
      where sessions_ended_at is null or login_deactivated_at is null`,
  );
  let owed = 0;
  for (const row of rows) {
    if (!isBusinessId(row.business_id)) continue;
    const settle = settleAccessEndings(
      database,
      row.business_id,
      logins,
      claimSeconds === undefined ? {} : { claimSeconds },
    );
    // eslint-disable-next-line no-await-in-loop -- one business at a time, each under its own tenancy
    owed += (await settle).owed;
  }
  return owed;
}

async function main(): Promise<void> {
  const environment = localEnvironment();
  const port = Number(environment['API_PORT'] ?? 8790);
  const databaseUrl = environment['DATABASE_URL'];
  const adminUrl = environment['DATABASE_ADMIN_URL'];
  const secret = environment['SUPABASE_JWT_SECRET'];
  const issuer = environment['GOTRUE_URL'];

  for (const [name, value] of [
    ['DATABASE_URL', databaseUrl],
    ['DATABASE_ADMIN_URL', adminUrl],
    ['SUPABASE_JWT_SECRET', secret],
    ['GOTRUE_URL', issuer],
  ] as const) {
    if (value === undefined || value === '') {
      console.error(`api: ${name} is not set. Run scripts/local/db-up.sh and auth-up.sh first.`);
      process.exit(1);
    }
  }

  const database = connect(databaseUrl as string, { source: 'runtime' });
  const admin = connectAsAdmin(adminUrl as string, { source: 'admin' });
  // Read once and handed to `composeApi` as values; none go into `process.env`.
  const keys = runtimeKeys(environment);
  // Checked at boot so a malformed keyring stops the server with its reason,
  // rather than serving until the first agent pickup refuses. The problem names
  // the setting, never a key's bytes.
  if (!keys.delegation.ok) {
    console.error(`api: delegation credential keys: ${keys.delegation.problem}`);
    process.exit(1);
  }

  // Wiring only: nothing here runs a statement or binds a port, so building it
  // before recovery changes nothing recovery sees, and recovery resolves its
  // keys through the same resolver the requests will.
  const { app, logins, resolveBusiness } = composeApi({
    database,
    admin,
    secret: secret as string,
    issuer: issuer as string,
    keys,
  });

  // Restart recovery (TRANSACTION-CONTRACT 84, 92), awaited before the port is
  // bound: a process start is the resume entry, and a failure is a failed
  // start rather than a server that serves beside an unfinished classification.
  const scope = parseRecoveryScope(environment[RECOVERY_SCOPE_SETTING]);
  if (!scope.ok) {
    console.error(`api: ${scope.problem}`);
    process.exit(1);
  }
  if (scope.keys.length === 0) {
    console.log('restart recovery: explicitly no deployment businesses');
  }
  const recovery = async () => await recoverDeployment(database, resolveBusiness, scope.keys);
  const recovered = await withRuntimeKeys(keys, recovery);
  if (!recovered.ok) {
    console.error(`api: ${recovered.problem}`);
    await Promise.allSettled([database.close(), admin.close()]);
    process.exit(1);
  }
  for (const business of recovered.businesses) console.log(describeRecovered(business));

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.log(`api: listening on http://127.0.0.1:${info.port}`);
    console.log('api: reads mounted');
  });

  // C58: the provider steps an access ending still owes, retried until each
  // is done. A failed pass is logged by its kind and tried again next time.
  const retry = setInterval(() => {
    retryAccessEndings(admin, database, logins).catch((cause: unknown) => {
      console.error(`api: access ending retry failed (${describeFault(cause)}); next pass retries`);
    });
  }, ACCESS_ENDING_RETRY_SECONDS * 1000);
  retry.unref();

  const stop = (): void => {
    clearInterval(retry);
    void Promise.allSettled([database.close(), admin.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const RETRY =
  'The service could not complete the request. Retry; if it persists, check /api/health.';

// Only as the process's entry (`node apps/api/server.ts`). An import, a test's
// included, gets `composeApi` and the helpers above and starts nothing.
if (import.meta.main) await main();
