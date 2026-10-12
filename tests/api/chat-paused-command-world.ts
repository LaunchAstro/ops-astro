// SPDX-License-Identifier: AGPL-3.0-only
//
// What the chat lock proofs share: a real command run through the envelope on
// its own database connection and paused at one statement until released, and
// a watcher that waits until a named advisory lock has a waiter, read from
// pg_locks rather than guessed with a delay.
import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  connect,
  type AdminConnection,
  type BusinessId,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';

function noop(): void {}

function signal() {
  let fire: () => void = noop;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

/** Which statement the command stops at, and whether before or after it runs. */
export interface Pause {
  readonly at: (sql: string, parameters: readonly unknown[]) => boolean;
  readonly when: 'before' | 'after';
}

export interface PausedCommand {
  /** Fired once the command has reached its pause. */
  readonly reached: Promise<void>;
  release(): void;
  /** The command's own result: an applied detail, or a refusal with `refused: true`. */
  readonly result: Promise<Readonly<Record<string, unknown>>>;
  /** Releases the pause if still held, waits for the command and closes its connection. */
  settle(): Promise<void>;
}

/** `own`, its transactions stopping at the first statement `pause.at` matches, once, at `stop`. */
function gatedOn(own: Database, pause: Pause, stop: () => Promise<void>): Database {
  let paused = false;
  return {
    ...own,
    withBusiness: async (business, run) =>
      await own.withBusiness(business, async (tx) => {
        const gated: TransactionQuery = {
          ...tx,
          query: async <Row>(sql: string, parameters: readonly unknown[] = []) => {
            const here = !paused && pause.at(sql, parameters);
            if (here) paused = true;
            if (here && pause.when === 'before') await stop();
            const rows = await tx.query<Row>(sql, parameters);
            if (here && pause.when === 'after') await stop();
            return rows;
          },
        };
        return await run(gated);
      }),
  };
}

/**
 * `request` sent through `executeCommand` as `presented` on a connection of its
 * own, paused at the first statement `pause.at` matches until released.
 */
export function pausedCommand(
  appUrl: string,
  businessId: BusinessId,
  presented: VerifiedSubject,
  request: Readonly<Record<string, unknown>> & { readonly command: string },
  pause: Pause,
): PausedCommand {
  const own = connect(appUrl);
  const reached = signal();
  const release = signal();
  const gated = gatedOn(own, pause, async () => {
    reached.fire();
    await release.fired;
  });
  const result = executeCommand(gated, businessId, presented, 'api', {
    operationId: randomUUID(),
    ...request,
  } as Parameters<typeof executeCommand>[4]) as unknown as Promise<
    Readonly<Record<string, unknown>>
  >;
  // A command that ends before its pause (a refusal at the door) still lets the caller go on.
  const ended = result.then(noop, noop);
  return {
    reached: Promise.race([reached.fired, ended]),
    release: release.fire,
    result,
    async settle() {
      release.fire();
      await ended;
      await own.close();
    },
  };
}

/**
 * `request` sent through `executeCommand` on a connection of its own, never
 * paused: a second caller whose statements do not queue behind another
 * caller's on one pooled connection.
 */
export async function ownCommand(
  appUrl: string,
  businessId: BusinessId,
  presented: VerifiedSubject,
  request: Readonly<Record<string, unknown>> & { readonly command: string },
): Promise<Readonly<Record<string, unknown>>> {
  const run = pausedCommand(appUrl, businessId, presented, request, {
    at: () => false,
    when: 'before',
  });
  try {
    return await run.result;
  } finally {
    await run.settle();
  }
}

/** The statement that takes an advisory lock on `key`, shared or exclusive. */
export function takesLock(key: string, mode: 'shared' | 'exclusive') {
  const verb = mode === 'shared' ? 'pg_advisory_xact_lock_shared(' : 'pg_advisory_xact_lock(';
  return (sql: string, parameters: readonly unknown[]): boolean =>
    sql.includes(verb) && parameters[0] === key;
}

/** The statement that writes a message with this body (`writeComment`). */
export function writesMessage(body: string) {
  return (sql: string, parameters: readonly unknown[]): boolean =>
    sql.startsWith('insert into records') && parameters[7] === body;
}

/**
 * The advisory lock on `key` as pg_locks shows it in this database: whether it
 * is held in `mode`, and whether a request in `mode` waits on it.
 */
export async function lockState(
  admin: AdminConnection,
  key: string,
  mode: 'shared' | 'exclusive',
): Promise<{ readonly held: boolean; readonly waiting: boolean }> {
  const rows = await admin.execute<{ readonly held: boolean; readonly waiting: boolean }>(
    `with k as (select hashtextextended($1, 0) as v)
     select coalesce(bool_or(l.granted), false) as held,
            coalesce(bool_or(not l.granted), false) as waiting
       from pg_locks l, k
      where l.locktype = 'advisory' and l.objsubid = 1
        and l.database = (select oid from pg_database where datname = current_database())
        and l.classid = ((k.v >> 32) & 4294967295)::oid
        and l.objid = (k.v & 4294967295)::oid
        and l.mode = $2`,
    [key, mode === 'shared' ? 'ShareLock' : 'ExclusiveLock'],
  );
  return rows[0] ?? { held: false, waiting: false };
}

/**
 * Wait until a request in `mode` waits on `key`, or `finished` says the caller
 * expected to wait has already answered; true when it was seen waiting.
 */
export async function waitsOn(
  admin: AdminConnection,
  key: string,
  mode: 'shared' | 'exclusive',
  finished: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (finished()) return false;
    // oxlint-disable-next-line no-await-in-loop -- observe each step until it waits or answers
    if ((await lockState(admin, key, mode)).waiting) return true;
    // oxlint-disable-next-line no-await-in-loop -- yield before the next observation
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`nothing waited on ${key} and the caller never answered`);
}

/** A promise with a flag saying whether it has settled yet. */
export function tracked<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly value: Promise<T>;
} {
  let settled = false;
  const value = promise.finally(() => {
    settled = true;
  });
  return { done: () => settled, value };
}
