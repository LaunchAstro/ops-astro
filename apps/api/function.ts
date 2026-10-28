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
// What `main` does that a function does not: the loopback identity route and
// the live channel's LISTEN.
//
// **Recovery has one owner here: the function.** The worker holds no database,
// so the function runs the reconciliation pass (`passDeployment`: sweep,
// replay, the register's answers) over the businesses `RECOVERY_BUSINESS_KEYS`
// names, which a named environment (`OPS_ENVIRONMENT`) must set, if only to
// `none`. Each business passes on its own, again each `SWEEP_INTERVAL_MS`
// after it succeeds. A request waits on the pass in flight until it ends: an
// instance may be frozen once it answers, and a pass frozen in a transaction
// keeps its row locks (#2240). So the pass has one deadline, `RECOVERY_WAIT_MS`
// from its start, over its key lookups and every phase: nothing starts past it,
// and the statement running at it is cancelled and rolled back first, so no
// request waits much past it (#1411). The pass runs on a connection of its own,
// and the longest owed goes first.
// `server.ts` runs the same pass only where there is no function.
//
// **Every session closes once idle (#1530).** The runtime pool, the pass's,
// the outbox and the lookup login keep no session state, and each closes a
// connection idle for `RUNTIME_IDLE_SECONDS`, so with the alias detached a
// migrate window drains without terminating anything.
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
// counts and sends (`apps/forwarder`). A response is handed back only once
// the events its own request raised are in the outbox or dropped, since the
// instance may be frozen once it answers; another request's never hold it.
// The sink's DSN is the forwarder's, so the entry refuses to start beside it.
// So is the release each event is sent with (`rebuiltError`), so the function
// reads no `OPS_RELEASE` (#1787).
//
// **The agent quota is per instance (API-2).** Its counts live in one
// process's memory and every instance starts its own, so each holds the
// installation's limits divided by the deployment's instance ceiling,
// `AGENT_QUOTA_INSTANCES` (4 unset; set it to the function's maximum
// instances), rounded down. A ceiling above the smallest limit would round a
// share up to one, so the entry refuses it at start-up. Together they stay
// within what one server holds.

import { join } from 'node:path';
import {
  connect,
  connectAsAdmin,
  connectOutbox,
  RUNTIME_IDLE_SECONDS,
  type AdminConnection,
} from '../../packages/core-records/src/index.ts';
import {
  crashSeamProblem,
  runtimeKeys,
  runtimeKeysProblem,
  type RuntimeKeys,
  withRuntimeKeys,
} from '../../packages/core-runtime/src/index.ts';
import { createOutboxAlerts, scopeKey, type OutboxAlerts } from './alerts/outbox.ts';
import { DEFAULT_AGENT_LIMITS, type AgentLimits, type Tiers } from './auth/agent-quota.ts';
import { publishableKey } from './auth/publishable-key.ts';
import { errorSinkLink } from './health/error-sink-link.ts';
import { keySetUrlFor } from './auth/supabase.ts';
import { carriedOption } from './model-carriage.ts';
import { passUntil } from './pass-deadline.ts';
import {
  parseRecoveryScope,
  passDeployment,
  RECOVERY_SCOPE_SETTING,
  registerEffectLookup,
  SWEEP_INTERVAL_MS,
} from './recovery-entry.ts';
import { HELD_ELSEWHERE } from './held-elsewhere.ts';
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
  // Unset, the runtime login stands in: no key resolves on it, and health still measures.
  const lookupUrl = settings['DATABASE_LOOKUP_URL'] || databaseUrl;
  const issuer = required('GOTRUE_URL');
  const keySetUrl = keySetUrlFor(settings['SUPABASE_KEY_SET_URL'] ?? '', issuer);
  if (keySetUrl === undefined) {
    throw new Error(
      'SUPABASE_KEY_SET_URL may name a loopback key set only, for a loopback issuer.',
    );
  }
  // The keyring from the settings alone: `runtimeKeys` would make a key file no instance shares.
  for (const name of ['DELEGATION_CREDENTIAL_KEY_ID', 'DELEGATION_CREDENTIAL_KEYS']) required(name);
  const keys = runtimeKeys(settings);
  const keysProblem = runtimeKeysProblem(keys);
  if (keysProblem !== undefined) throw new Error(keysProblem);
  const alerts = outboxAlerts(settings, databaseUrl, required);
  const database = connect(databaseUrl, { source: 'runtime' });
  const lookup = connectAsAdmin(lookupUrl, { source: 'lookup', idleSeconds: RUNTIME_IDLE_SECONDS });
  const { app } = composeApi({
    database,
    admin: lookup,
    signIn: { issuer, keySetUrl },
    providerKey: publishableKey(settings['SUPABASE_PUBLISHABLE_KEY']),
    keys,
    errorSink: errorSinkLink(settings),
    ...(alerts === undefined ? {} : { alerts }),
    agentLimits: perInstance(settings['AGENT_QUOTA_INSTANCES']),
    ...carriedOption(settings),
  });
  const pass = recoveryPass(settings, databaseUrl, lookup, keys);

  return async (request) => {
    const hosts = [request.headers.get('host') ?? '', new URL(request.url).host];
    if (hosts.some((host) => host.toLowerCase() !== servedHost)) {
      return new Response(null, { status: 421, headers: { 'cache-control': 'private, no-store' } });
    }
    await pass();
    return await answered(app, request, alerts);
  };
}

/** The app's answer, handed back once the events this request raised are in the outbox or dropped. */
async function answered(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  request: Request,
  alerts: OutboxAlerts | undefined,
): Promise<Response> {
  const fetched = async (): Promise<Response> => await app.fetch(request);
  return await (alerts === undefined ? fetched() : alerts.raisedBy(fetched));
}

/** How long after it starts the reconciliation pass is over, its running statement cancelled. */
export const RECOVERY_WAIT_MS = 2_000;

/** The most instances the limits split across with at least one of each. */
const INSTANCES_MOST = Math.min(
  ...[
    DEFAULT_AGENT_LIMITS.requests,
    DEFAULT_AGENT_LIMITS.concurrent,
    DEFAULT_AGENT_LIMITS.exports,
  ].flatMap((all) => Object.values(all)),
  DEFAULT_AGENT_LIMITS.refused,
);
const INSTANCES_UNSET = INSTANCES_MOST;

/** The default limits split across the instance ceiling, rounded down. */
function perInstance(setting: string | undefined): AgentLimits {
  const given = setting === undefined || setting === '' ? String(INSTANCES_UNSET) : setting;
  const instances = /^\d+$/u.test(given) ? Number(given) : 0;
  if (instances < 1) throw new Error('AGENT_QUOTA_INSTANCES is not a whole number of instances.');
  if (instances > INSTANCES_MOST) {
    throw new Error(
      `AGENT_QUOTA_INSTANCES is above ${INSTANCES_MOST}, the smallest agent limit, so a share would round up.`,
    );
  }
  const share = (limit: number): number => Math.floor(limit / instances);
  const tiers = (all: Tiers): Tiers => ({
    credential: share(all.credential),
    person: share(all.person),
    business: share(all.business),
  });
  const { requests, concurrent, exports, refused } = DEFAULT_AGENT_LIMITS;
  return {
    requests: tiers(requests),
    concurrent: tiers(concurrent),
    exports: tiers(exports),
    refused: share(refused),
  };
}

/**
 * The reconciliation pass the function owns, over `RECOVERY_BUSINESS_KEYS`:
 * each business at most once each `SWEEP_INTERVAL_MS` after its pass succeeds,
 * awaited by every request to its end, `RECOVERY_WAIT_MS` after it starts at most.
 * It opens its own connection at its first statement, so a pass waiting on a
 * lock leaves the runtime one to the requests; it reads keys on `lookup`. A
 * business passes on its own, so a key that does not resolve, or a pass that
 * rolls back, holds up no other (#287 A8).
 * `none` does nothing; unset does nothing only where no environment is named,
 * and a malformed value throws at start.
 */
function recoveryPass(
  settings: Settings,
  databaseUrl: string,
  lookup: AdminConnection,
  keys: RuntimeKeys,
): () => Promise<void> {
  const raw = settings[RECOVERY_SCOPE_SETTING];
  const named = (settings['OPS_ENVIRONMENT'] ?? '') !== '';
  const scope = raw === undefined && !named ? undefined : parseRecoveryScope(raw);
  if (scope?.ok === false) throw new Error(scope.problem);

  const connected = connect(databaseUrl, { source: 'runtime' });
  const due = new Map<string, number>();
  let running: Promise<void> | undefined;
  const run = async (owed: readonly string[]): Promise<void> => {
    const deadline = Date.now() + RECOVERY_WAIT_MS;
    const { database, resolveBusiness } = passUntil(deadline, connected, lookup);
    for (const key of owed) {
      // One business at a time, as `passDeployment` runs them, and none begun past the deadline.
      if (Date.now() >= deadline) break;
      // eslint-disable-next-line no-await-in-loop
      const outcome = await withRuntimeKeys(
        keys,
        async () => await passDeployment(database, resolveBusiness, [key], registerEffectLookup),
      ).catch((cause: unknown) => ({
        ok: false as const,
        problem: cause instanceof Error ? cause.message : 'unknown',
      }));
      // Only a pass that finished marks its interval done; a failed one runs again, after the others owed.
      due.set(key, Date.now() + (outcome.ok ? SWEEP_INTERVAL_MS : 0));
      if (!outcome.ok) console.error(`api: reconciliation pass: ${outcome.problem}`);
    }
  };
  return async (): Promise<void> => {
    const owed = scope?.keys.filter((key) => Date.now() >= (due.get(key) ?? 0)) ?? [];
    owed.sort((one, other) => (due.get(one) ?? 0) - (due.get(other) ?? 0));
    if (running === undefined && owed.length > 0) {
      running = run(owed).finally(() => {
        running = undefined;
      });
    }
    if (running !== undefined) await running;
  };
}

/** A deployment's alerts, on the outbox; none where neither setting is given (the local world). */
function outboxAlerts(
  settings: Settings,
  databaseUrl: string,
  required: (name: string) => string,
): OutboxAlerts | undefined {
  const where = settings['OPS_ENVIRONMENT'] ?? '';
  if (where === '' && (settings['ALERT_SCOPE_KEY'] ?? '') === '') return undefined;
  if (where !== 'staging' && where !== 'production') {
    throw new Error('OPS_ENVIRONMENT must be staging or production.');
  }
  const key = scopeKey(required('ALERT_SCOPE_KEY'));
  const outbox = connectOutbox(databaseUrl, { source: 'runtime' });
  return createOutboxAlerts({ outbox, key, where, root: ROOT });
}

let handler: ((request: Request) => Promise<Response>) | undefined;

/** Vercel's Node.js function signature, one export per method: built on first use. */
async function handle(request: Request): Promise<Response> {
  const held = HELD_ELSEWHERE.filter((name) => (process.env[name] ?? '') !== '');
  if (held.length > 0) {
    throw new Error(
      `${held.join(', ')} set: the function never holds the admin login, the sink key, the provider's admin key or a backup credential.`,
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
