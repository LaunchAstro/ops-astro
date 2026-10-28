// SPDX-License-Identifier: AGPL-3.0-only
//
// The hosted function over one synthetic business, for the proofs that its
// reconciliation pass holds no request past the pass deadline (#2240, #1411).
// A holder is a session of its own on the business's database that takes the
// locks the pass then waits on; `waiting` reads which statement waits.

import { randomBytes } from 'node:crypto';
import { createFunctionHandler, RECOVERY_WAIT_MS } from '../../apps/api/function.ts';
import { Client, dropLogins, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

/** The request bound the proofs hold the function to: the pass deadline and #1411's tolerance. */
export const BOUND_MS: number = RECOVERY_WAIT_MS + 1_000;

/** One statement waiting on a lock: its session and when it started. */
export interface Waiting {
  readonly pid: number;
  readonly started: string;
}

export interface BoundWorld {
  readonly s: Schedules;
  /** The expired live work's lease, which the pass expires once it runs whole. */
  readonly leaseId: string;
  readonly reservationId: string;
  readonly lookupLogin: string;
  readonly handle: (request: Request) => Promise<Response>;
  /** A new session that keeps its locks until `end`. */
  readonly holder: () => Client;
  /** The statement matching `pattern` that a session of `login` waits on a lock in, if any. */
  readonly waiting: (pattern: string, login?: string) => Promise<Waiting | undefined>;
  /** The sessions of `login` inside a transaction. */
  readonly open: (login?: string) => Promise<number>;
  readonly end: () => Promise<void>;
}

export const request = (path: string): Request =>
  new Request(`https://ops.example.test${path}`, { headers: { host: 'ops.example.test' } });

/** The answer's status, or `held` once `BOUND_MS` has passed since `started`. */
export async function withinBound(
  response: Promise<Response>,
  started: number,
): Promise<number | 'held'> {
  let timer: NodeJS.Timeout | undefined;
  const held = new Promise<'held'>((resolve) => {
    timer = setTimeout(() => resolve('held'), started + BOUND_MS - performance.now());
  });
  try {
    return await Promise.race([response.then((answer) => answer.status), held]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The hosted function over `part`'s one business, on `databaseUrl` and the lookup login's `lookupUrl`. */
function functionOver(
  part: string,
  databaseUrl: string,
  lookupUrl: string,
): (request: Request) => Promise<Response> {
  const keyId = `test/${part}@1`;
  return createFunctionHandler({
    DATABASE_URL: databaseUrl,
    DATABASE_LOOKUP_URL: lookupUrl,
    GOTRUE_URL: TEST_ISSUER,
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
    RECOVERY_BUSINESS_KEYS: `schedules-${part}`,
  });
}

/**
 * A business with live work on a lease that has expired, and the function
 * that recovers it, reaching the database at the URL `reach` gives for it.
 */
export async function boundWorld(
  part: string,
  reach: (appUrl: string) => string | Promise<string> = (appUrl) => appUrl,
): Promise<BoundWorld> {
  const s = await openSchedules(part, 100_000);
  const work = await liveWork(s, `Synthetic ${part} work`, 1_000);
  const leaseId = String(work.picked['leaseId']);
  await s.db.admin.execute(
    "update public.leases set expires_at = now() - interval '1 minute' where id = $1",
    [leaseId],
  );
  const url = new URL(databaseUrlFromEnvironment() ?? '');
  url.pathname = `/${s.db.name}`;
  const lookup = await loginIn(s.db, 'ops_astro_lookup', part);
  const handle = functionOver(part, await reach(s.db.appUrl), lookup.url);
  const holders: Client[] = [];
  const pending: Promise<unknown>[] = [];
  const answer = async (incoming: Request): Promise<Response> => {
    const response = handle(incoming);
    pending.push(response.catch(() => null));
    return await response;
  };
  return {
    s,
    leaseId,
    reservationId: String(work.decision['reservationId']),
    lookupLogin: lookup.name,
    handle: answer,
    holder: () => {
      const holder = new Client(url.toString());
      holders.push(holder);
      return holder;
    },
    waiting: async (pattern, login = s.db.loginRole) => await waitingIn(s, pattern, login),
    open: async (login = s.db.loginRole) => await openIn(s, login),
    end: async () => {
      await Promise.all(holders.map(async (holder) => await holder.query('rollback')));
      await Promise.all(pending);
      await handle(request('/api/sign-in'));
      await Promise.all(holders.map(async (holder) => await holder.end()));
      await dropLogins(s.db, [lookup.name]);
    },
  };
}

async function waitingIn(
  s: Schedules,
  pattern: string,
  login: string,
): Promise<Waiting | undefined> {
  const [row] = await s.db.admin.execute<Waiting>(
    `select pid, query_start::text as started from pg_stat_activity
      where datname = current_database() and usename = $1
        and wait_event_type = 'Lock' and query ilike $2`,
    [login, pattern],
  );
  return row;
}

async function openIn(s: Schedules, login: string): Promise<number> {
  const [row] = await s.db.admin.execute<{ open: number }>(
    `select count(*)::int as open from pg_stat_activity
      where datname = current_database() and usename = $1 and xact_start is not null`,
    [login],
  );
  return row?.open ?? -1;
}
