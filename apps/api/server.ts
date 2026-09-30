// SPDX-License-Identifier: AGPL-3.0-only
//
// The composition root. With the function entry (`function.ts`), which builds
// the same `composeApi` on Vercel, the only place that reads the environment,
// opens a connection, chooses an authentication adapter and binds a port.
//
// Everything the boundary needs is handed to it here, which is what makes the
// claims in `app.ts` checkable: there is exactly one construction of the
// verifier, one business resolver and one database, and they are visible in
// one file rather than spread across the modules that use them.
//
// The file is two halves. `composeApi` is the wiring and nothing else: given
// the connections and the key set's address it builds the served app, fault mapping
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
// **The business key is resolved as the lookup identity, and only the key.**
// The tenancy root is behind forced row security keyed on the setting the
// serving transaction has not set yet, so the mapping from a path segment to a
// business identifier cannot be read by the application role: it is the one
// lookup that has to precede tenancy. It runs as `ops_astro_lookup` (0046),
// which reads a business's id and key and nothing else, on the owner's
// connection locally and on the function's lookup login on Vercel (G2). It
// reads one column of one row by key and answers nothing else, and every
// statement after it runs through `withBusiness` like everything else in the
// slice.

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  connect,
  connectAsAdmin,
  connectListener,
  connectSessionEnds,
  loginLiveElsewhere,
  isBusinessId,
  KEY_FILE_VARIABLE,
  readEnvFile,
} from '../../packages/core-records/src/index.ts';
import type {
  AdminConnection,
  Database,
  SessionEnds,
} from '../../packages/core-records/src/index.ts';
import { createApi, type LiveOptions, type ReadExecutor } from './app.ts';
import { createAlerts, faultCode, sinkFrom, type Alerts } from './alerts/sink.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead as readExecutor,
  type LoginProvider,
} from '../../packages/core-commands/src/index.ts';
import {
  CRASH_POINT_VARIABLE,
  crashSeamProblem,
  runtimeKeys,
  withRuntimeKeys,
} from '../../packages/core-runtime/src/index.ts';
import type { RuntimeKeys } from '../../packages/core-runtime/src/index.ts';
import { createGoTrueFactors } from './auth/factors.ts';
import { createLangfuseHealth } from './health/tracing.ts';
import { goTrueLogins, providerAdminKey } from './auth/provider-logins.ts';
import {
  createSupabaseVerifier,
  keySetUrlFor,
  type SupabaseVerifierOptions,
} from './auth/supabase.ts';
import { startLiveTopics } from './live.ts';
import { isLoopback, migrationHead, readIdentity, type ServedIdentity } from './identity.ts';
import {
  describeRecovered,
  parseRecoveryScope,
  recoverDeployment,
  passDeployment,
  registerEffectLookup,
  startSweeper,
  RECOVERY_SCOPE_SETTING,
} from './recovery-entry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A well-formed business id that names no business: health's statement reads nothing. */
const NIL_BUSINESS = '00000000-0000-0000-0000-000000000000';

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
    // the same reason, and never the gate key.
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

    // As the lookup identity (0046), which reads id and key and nothing else.
    const rows = await admin.transaction(async (execute) => {
      await execute('set local role ops_astro_lookup');
      return await execute<{ id: string }>(
        'select id from public.businesses where key = $1 limit 2',
        [businessKey],
      );
    });
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
  /**
   * The connection the business key (as the lookup identity) and `/api/health`
   * run on: the owner's locally, the lookup login on Vercel. The identity
   * route, mounted only by `main`, reads the migration ledger on it too.
   */
  readonly admin: AdminConnection;
  /** The issuer and published key set bearers are checked against: public keys only. */
  readonly signIn: Omit<SupabaseVerifierOptions, 'onRefusal'>;
  /** The signing key and delegation keyring `main` read, never put in `process.env`. */
  readonly keys: RuntimeKeys;
  /**
   * The provider admin API's key (`providerAdminKey`), for C58's calls on an
   * ended login only; sign-in never reads it. Absent, those calls are not sent
   * and stay owed.
   */
  readonly providerAdminKey?: () => Promise<string>;
  /** Where the browser's sign-out ends a provider session for every business (C58, 0065). */
  readonly sessionEnds?: SessionEnds;
  /** Langfuse's URL, `LANGFUSE_HOST` (C34); absent is tracing switched off. */
  readonly tracingUrl?: string;
  /**
   * The read half of the surface. Absent means `reads/execute.ts`, imported
   * statically, so a module that fails to load stops the server rather than
   * turning every read into `DEPENDENCY_NOT_LANDED`. A test hands in its own
   * to reach the fault branch.
   */
  readonly executeRead?: ReadExecutor;
  /** Read once at process start (`identity.ts`); absent, the identity route is not mounted. */
  readonly identity?: ServedIdentity;
  /** The live task channel, started by `main`; absent, the event route is not mounted. */
  readonly live?: LiveOptions;
  /** The error sink and the security detections (ticket S0-2); absent without a sink. */
  readonly alerts?: Alerts;
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
  const logins = goTrueLogins(config.providerAdminKey, config.signIn.issuer);
  const resolveBusiness = createBusinessResolver(admin);
  const server = new Hono();
  // S0-6 no edge caching: the API is served behind Vercel's edge network, so
  // every answer under /api, a refusal, a fault and a missing route included,
  // tells every cache on the way not to keep it.
  server.use('/api/*', async (context, next) => {
    await next();
    context.res.headers.set('cache-control', 'private, no-store');
  });
  // This app's keys, for this request only: no other composition can replace them.
  server.use(async (_context, next) => await withRuntimeKeys(config.keys, next));

  // Measured, not assumed. `reachable` is the result of a statement that ran
  // on the runtime login (G2): the lookup answering proves nothing about it.
  // The nil id names no business, so the statement reads no row.
  server.get('/api/health', async (context) => {
    let reachable = false;
    let detail = '';
    let notificationQueue: number | null = null;
    try {
      const [row] = await database.withBusiness(
        NIL_BUSINESS,
        async (tx) =>
          await tx.query<{ usage: number }>('select pg_notification_queue_usage() as usage'),
      );
      notificationQueue = row?.usage ?? null;
      reachable = true;
    } catch (cause) {
      detail = cause instanceof Error ? cause.message : 'unknown';
    }
    return context.json(
      {
        ok: reachable,
        database: reachable ? 'reachable' : 'unreachable',
        reads: 'mounted',
        ...(config.live === undefined
          ? {}
          : { live: config.live.topics.listening ? 'listening' : 'down', notificationQueue }),
        detail,
      },
      reachable ? 200 : 503,
    );
  });

  // G3: the page reads its sign-in address here, so one web build serves every
  // environment. The issuer is public, and nothing is read to answer it.
  server.get('/api/sign-in', (context) => context.json({ issuer: config.signIn.issuer }));

  const { identity } = config;
  if (identity !== undefined) {
    // Loopback only: the answer names the checkout path and the process id.
    server.get('/api/identity', async (context) => {
      const peer = (
        context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
      )?.incoming?.socket?.remoteAddress;
      if (!isLoopback(peer)) return context.notFound();
      const ledger = await admin.execute<{ version: string; checksum: string }>(
        'select version, checksum from ops.schema_migrations',
      );
      return context.json({ ...identity, migrationHead: migrationHead(ledger) }, 200);
    });
  }

  server.route(
    '/',
    createApi({
      database,
      verify: createSupabaseVerifier({
        ...config.signIn,
        // The reason alone: an answer the provider sent is never repeated.
        onRefusal: ({ reason }) => {
          console.error(`api: the sign-in key set answer was refused (${reason})`);
        },
      }),
      resolveBusiness,
      executeRead,
      executeCommand,
      executeAgentCommand,
      ...(config.live === undefined ? {} : { live: config.live }),
      // The provider GoTrue is: the one destination its factor calls reach.
      factors: createGoTrueFactors({ baseUrl: config.signIn.issuer }),
      ...(config.sessionEnds === undefined ? {} : { sessionEnds: config.sessionEnds }),
      logins,
      // Only where a provider key is held (the local server): the Vercel
      // function has none, so it asks the owner nothing and leaves every
      // provider step to the endings loop (ORCH47).
      ...(config.providerAdminKey === undefined
        ? {}
        : {
            sharedLogin: async (subject: string, businessId: string) =>
              await loginLiveElsewhere(admin, subject, businessId),
          }),
      // C34: tracing where switched on; the watcher and error sink are C29's.
      health:
        config.tracingUrl === undefined
          ? {}
          : { tracing: createLangfuseHealth({ baseUrl: config.tracingUrl }) },
      ...(config.alerts === undefined ? {} : { observe: config.alerts.observe }),
    }),
  );

  // A fault reaching here is a fault, not a refusal, and it is reported as one
  // rather than as a 404 that reads like a missing route or a 403 that reads
  // like a decision. The message is neither echoed nor logged: a message may
  // carry a value. The log gets a bounded code and a reference.
  server.onError((cause, context) => {
    const reference = randomUUID();
    console.error(
      `api: unhandled fault ${faultCode(cause)} (reference ${reference}): the request ` +
        'could not be completed. Its contents and the fault text are left out of this log.',
    );
    void config.alerts?.fault(cause);
    if ('getResponse' in cause) return cause.getResponse();
    return context.json({ code: 'SERVICE_UNAVAILABLE', names: [], fixes: [RETRY] }, 503);
  });

  return { app: server, logins, resolveBusiness };
}

async function main(): Promise<void> {
  // T2c1: the crash seam is test-only, so an armed one outside test mode stops the start.
  const seam = crashSeamProblem(process.env);
  if (seam !== undefined) {
    console.error(`api: ${seam}`);
    process.exit(1);
  }
  if ((process.env[CRASH_POINT_VARIABLE] ?? '') !== '') {
    console.warn(
      `api: CRASH SEAM ARMED at ${String(process.env[CRASH_POINT_VARIABLE])} (test mode)`,
    );
  }
  const environment = localEnvironment();
  const port = Number(environment['API_PORT'] ?? 8790);
  const databaseUrl = environment['DATABASE_URL'];
  const adminUrl = environment['DATABASE_ADMIN_URL'];
  const issuer = environment['GOTRUE_URL'];
  const tracingUrl = environment['LANGFUSE_HOST'];
  const adminKey = providerAdminKey(environment, join(ROOT, '.local'));

  // A test's stand-in set, for a loopback issuer only: a hosted issuer's
  // tokens are checked against that provider's own published set, always.
  const keySetUrl = keySetUrlFor(environment['SUPABASE_KEY_SET_URL'] ?? '', issuer ?? '');
  if (keySetUrl === undefined) {
    console.error(
      'api: SUPABASE_KEY_SET_URL may name a loopback key set only, for a loopback issuer.',
    );
    process.exit(1);
  }
  for (const [name, value] of [
    ['DATABASE_URL', databaseUrl],
    ['DATABASE_ADMIN_URL', adminUrl],
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

  // LISTEN needs a direct or session-mode connection: hosted, `DATABASE_LISTEN_URL`.
  const listenUrl = environment['DATABASE_LISTEN_URL'] ?? (databaseUrl as string);
  const topics = await startLiveTopics(connectListener(listenUrl));
  const alerts = alertsFrom(environment);

  // Wiring only: nothing here runs a statement or binds a port, so building it
  // before recovery changes nothing recovery sees, and recovery resolves its
  // keys through the same resolver the requests will.
  const { app, resolveBusiness } = composeApi({
    identity: readIdentity(ROOT),
    database,
    admin,
    signIn: { issuer: issuer as string, keySetUrl },
    keys,
    live: { topics },
    sessionEnds: connectSessionEnds(databaseUrl as string, { source: 'runtime' }),
    ...(adminKey === undefined ? {} : { providerAdminKey: adminKey }),
    ...(tracingUrl === undefined || tracingUrl === '' ? {} : { tracingUrl }),
    ...(alerts === undefined ? {} : { alerts }),
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
    await Promise.allSettled([database.close(), admin.close(), topics.close()]);
    process.exit(1);
  }
  for (const business of recovered.businesses) console.log(describeRecovered(business));

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.log(`api: listening on http://127.0.0.1:${info.port}`);
    console.log('api: reads mounted');
  });

  // T3b: the sweep, the reconciliation pass's lease-expiry phase, beside
  // start-time recovery and over the same businesses, as system work on an
  // interval once the port is bound (T3.md:28). Not an agent route: nothing
  // on the wire reaches it (RN-10).
  const sweeper = startSweeper(
    async () =>
      await withRuntimeKeys(keys, async () => {
        return await passDeployment(database, resolveBusiness, scope.keys, registerEffectLookup);
      }),
  );

  // C58: what the act could not settle, the endings loop retries (`apps/endings`).

  const stop = (): void => {
    sweeper.stop();
    // The live streams first: a question one has in flight ends before its pool does.
    void Promise.allSettled([topics.close()])
      .then(async () => await Promise.allSettled([database.close(), admin.close()]))
      .then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** The error sink (ticket S0-2): none without a DSN; a bad setting stops the server. */
function alertsFrom(environment: Readonly<Record<string, string | undefined>>): Alerts | undefined {
  try {
    const sink = sinkFrom(environment);
    return sink && createAlerts({ ...sink, root: ROOT });
  } catch (error) {
    console.error(`api: ${(error as Error).message}`);
    process.exit(1);
  }
}

const RETRY =
  'The service could not complete the request. Retry; if it persists, check /api/health.';

// Only as the process's entry (`node apps/api/server.ts`). An import, a test's
// included, gets `composeApi` and the helpers above and starts nothing.
if (import.meta.main) await main();
