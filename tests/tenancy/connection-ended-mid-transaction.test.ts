// SPDX-License-Identifier: AGPL-3.0-only
//
// #1774: a connection the server ends while a transaction on it is still
// running. postgres.js 3.4.9 nulls the socket when it closes, and a later
// statement on that transaction, or the rollback or commit `begin` sends for
// it, was written to the null socket from a timer: an uncaught TypeError that
// ended the process. After a reconnect the same statements went to the new
// session instead, which by then could be another business's transaction.
//
// Each connection kind runs in its own process
// (connection-ended-mid-transaction.run.ts), because the failure is the
// process ending. The backend is ended with `pg_terminate_backend`, as a
// migrate window, a pooler restart or a failover ends one.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'connection ended mid-transaction: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const script = fileURLToPath(new URL('./connection-ended-mid-transaction.run.ts', import.meta.url));

interface Outcome {
  readonly status: number | null;
  readonly stderr: string;
  readonly result: Record<string, unknown> | undefined;
}

function runCase(kind: string, url: string): Outcome {
  const child = spawnSync(process.execPath, [script, kind, url, serverUrl as string], {
    encoding: 'utf8',
    timeout: 45_000,
  });
  const line = child.stdout.trim().split('\n').at(-1);
  return {
    status: child.status,
    stderr: child.stderr,
    result: line === undefined || line === '' ? undefined : JSON.parse(line),
  };
}

const refused = { ok: false, code: 'CONNECTION_CLOSED', addressed: true };

/** The process ran to its end, with no TypeError, and printed `result`. */
function expectRan(outcome: Outcome, result: Record<string, unknown>): void {
  expect(outcome.stderr).not.toMatch(/TypeError/u);
  expect(outcome.status).toBe(0);
  expect(outcome.result).toEqual(result);
}

/** The transaction and its next statement were refused, and the connection serves again. */
function expectSurvivedAndRefused(outcome: Outcome): void {
  expectRan(outcome, { caller: refused, statement: refused, after: { ok: true } });
}

describe.skipIf(serverUrl === undefined)('a connection ended mid-transaction', () => {
  let db: FreshDatabase;
  let ownerUrl: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'conn_ended' });
    const owner = new URL(serverUrl as string);
    owner.pathname = `/${db.name}`;
    ownerUrl = owner.toString();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('the runtime pool: the process survives and the caller and its next statement are refused', () => {
    expectSurvivedAndRefused(runCase('runtime', db.appUrl));
  }, 60_000);

  it('the runtime pool after a reconnect: nothing from the ended transaction reaches the next business', () => {
    const outcome = runCase('reconnected', db.appUrl);
    expect(outcome.status).toBe(0);
    expect(outcome.result).toEqual({
      caller: refused,
      statement: refused,
      beta: {
        ok: true,
        row: { stale: 'beta', business: '00000000-0000-4000-8000-00000000000b' },
      },
    });
  }, 60_000);

  it('the admin transaction: the process survives and the caller and its next statement are refused', () => {
    expectSurvivedAndRefused(runCase('admin', ownerUrl));
  }, 60_000);

  it('a statement in flight when the backend ends: it is refused and the handle still ends', () => {
    expectRan(runCase('inFlight', ownerUrl), { caller: refused, ended: { ok: true } });
  }, 60_000);

  it('the outbox: the process survives, the append in flight is refused and the next one lands', () => {
    expectRan(runCase('outbox', db.appUrl), { caller: refused, after: { ok: true } });
  }, 60_000);

  it('the listener: the process survives its session ending and listens again', () => {
    expectRan(runCase('listener', db.appUrl), { listening: 2 });
  }, 60_000);
});
