// SPDX-License-Identifier: AGPL-3.0-only
//
// What the carriage race cases share: an exchange whose broker carries its
// conversation calls (`Broker.carrier`) over the stand-in Ollama, a composition
// root of its own on a pool of its own (so two commands in one case hold
// transactions on separate connections), and the business's audit-chain lock,
// which every command takes just before it commits, so a case can stop a
// command there with everything it locked still held.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import { composeApi } from '../../apps/api/server.ts';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import {
  catalogue,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody, type Carrier } from '../../packages/core-custody/src/index.ts';
import {
  conversationExchange,
  type ConversationExchange,
} from '../../packages/core-commands/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  connect,
  type AdminConnection,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { testSignIn } from '../support/sign-in.ts';
import { ISSUER, type ApiFixture } from './fixture.ts';

/** The broker's settings over one local route to the stand-in at `origin`, its key in `folder`. */
function settingsFor(origin: string, folder: string) {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'ollama_key',
        kind: 'api_key',
        account: 'm5-ollama',
        destination: 'ollama',
        header: 'authorization',
        value: `local-${String(Date.now())}`,
      },
    ]),
    { mode: 0o600 },
  );
  const settings = brokerSettings({
    OPS_AGENT_PROVIDER: 'ollama',
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'ollama', origin }]),
    MODEL_BROKER_ROUTES: JSON.stringify([
      {
        key: 'm5_ollama',
        reach: 'local',
        provider: 'ollama',
        credentialRef: 'ollama_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
    ]),
    MODEL_BROKER_INSTALLATION: 'here',
  });
  if (settings.kind !== 'configured') throw new Error(`broker ${settings.kind}`);
  return settings;
}

/** An exchange whose calls are carried by `carrier`'s agent, sent through custody to `origin`. */
export async function carriedOllama(
  origin: string,
  carrier: Carrier,
): Promise<{ readonly exchange: ConversationExchange; stop(): Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), 'carried-race-'));
  const settings = settingsFor(origin, folder);
  const custody = await startCustody(settings.custody);
  const exchange = conversationExchange({
    custody,
    operations: catalogue([OLLAMA_CONVERSATION]),
    providers: new Map([[OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }]]),
    routes: settings.routes,
    installation: settings.installation,
    carrier,
  });
  return {
    exchange,
    stop: async () => {
      await custody.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** A composition root with `carrier`, on a pool of its own; close the pool when done. */
export function carriedApi(
  fixture: ApiFixture,
  carrier: Carrier,
): { readonly api: Hono; readonly database: Database } {
  const database = connect(fixture.db.appUrl, { source: 'runtime' });
  const api: Hono = composeApi({
    keys: runtimeKeys({ ...fixture.environment }),
    database,
    admin: fixture.db.admin,
    signIn: testSignIn(ISSUER),
    executeRead,
    carrier,
  }).app;
  return { api, database };
}

/**
 * The SQL that takes a person's session-ending key (`ending-keys.ts`) by their
 * provider subject. A write asks it, shared, once its handler has done its
 * work, so holding it stops a command just before it commits.
 */
export const takeEndingLock =
  "select pg_advisory_xact_lock(hashtextextended('session-ending:subject:' || $1, 0))";

/** The SQL that takes the business's audit-chain lock, as the chain's trigger takes it. */
export const takeChainLock = 'select pg_advisory_xact_lock(hashtextextended($1::text, 0))';

/** Waits until a backend waits on a lock the backend `pid` holds; answers how many do. */
export async function waitersOf(
  admin: Pick<AdminConnection, 'execute'>,
  pid: number,
  n = 1,
): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    const rows = await admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and $1::int = any(pg_blocking_pids(pid))`,
      [pid],
    );
    if ((rows[0]?.n ?? 0) >= n) return;
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    await sleep(10);
  }
  throw new Error(`${String(n)} backends never waited on the backend ${String(pid)}`);
}

/**
 * Waits until a backend whose statement contains `statement` is blocked by
 * another backend, other than `notBy` (a holder the case set up itself).
 */
export async function blockedIn(
  admin: Pick<AdminConnection, 'execute'>,
  statement: string,
  notBy = -1,
): Promise<number> {
  for (let tries = 0; tries < 500; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    const rows = await admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and strpos(query, $1) > 0 and cardinality(pg_blocking_pids(pid)) > 0
          and not ($2::int = any(pg_blocking_pids(pid)))
        limit 1`,
      [statement, notBy],
    );
    const pid = rows[0]?.pid;
    if (pid !== undefined) return Number(pid);
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    await sleep(10);
  }
  throw new Error(`nothing was ever blocked in "${statement}"`);
}

/** Whether the backend `waiter` is blocked by the backend `holder`, now. */
export async function blockedBy(
  admin: Pick<AdminConnection, 'execute'>,
  waiter: number,
  holder: number,
): Promise<boolean> {
  const rows = await admin.execute<{ readonly blocked: boolean }>(
    'select $2::int = any(pg_blocking_pids($1::int)) as blocked',
    [waiter, holder],
  );
  return rows[0]?.blocked === true;
}

export interface HeldApp<T> {
  /** The holding backend, which a waiter names as its blocker. */
  readonly pid: number;
  /** What `take` answered. */
  readonly taken: T;
  /** Runs `last` (if given), then commits, or rolls back when `last` throws; closes the pool. */
  letGo(last?: (tx: TenantQuery) => Promise<void>): Promise<void>;
}

/**
 * A transaction of the application role, on a connection of its own, under
 * the business: `take` runs in it, and what it locked stays locked until
 * `letGo`. The product's own functions run in it as they run in a command.
 */
export async function holdApp<T>(
  appUrl: string,
  businessId: string,
  take: (tx: TenantQuery) => Promise<T>,
): Promise<HeldApp<T>> {
  const db = connect(appUrl, { source: 'runtime' });
  const held = latchOf<{ readonly pid: number; readonly taken: T }>();
  const release = latchOf<((tx: TenantQuery) => Promise<void>) | undefined>();
  const done = db.withBusiness(businessId as BusinessId, async (tx) => {
    const taken = await take(tx);
    const [me] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    held.open({ pid: Number(me?.pid), taken });
    const last = await release.promise;
    await last?.(tx);
  });
  const first = await Promise.race([held.promise, done.then(() => null)]).catch(
    async (cause: unknown) => {
      await db.close();
      throw cause;
    },
  );
  if (first === null) throw new Error('holdApp: the holder ended before it held');
  let gone: Promise<void> | undefined;
  return {
    pid: first.pid,
    taken: first.taken,
    letGo: async (last) => {
      gone ??= (async () => {
        release.open(last);
        try {
          await done;
        } finally {
          await db.close();
        }
      })();
      await gone;
    },
  };
}

const unopened = (): void => {
  // Replaced by the promise's own resolver.
};

function latchOf<T>(): { readonly promise: Promise<T>; readonly open: (value: T) => void } {
  let open: (value: T) => void = unopened;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
