// SPDX-License-Identifier: AGPL-3.0-only
//
// What the frontier decision item's race, crash and retry proofs share. A
// ticket lands on its map's frontier inside `map_summary_refresh`, under the
// map's own advisory lock; the decision item is raised there by the frontier
// row's insert trigger and taken back at commit if the ticket left again. The
// proofs hold that lock, a twin item or a sign-in key on a connection of their
// own, see each writer waiting in `pg_stat_activity` (`pg_blocking_pids`),
// never after a sleep, and let go. Every writer runs on a pool of its own.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import {
  connect,
  connectAsAdmin,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, type Held } from '../support/lock-wait-race.ts';
import { must, type Member, type WayfinderWorld } from './world.ts';

type Body = Readonly<Record<string, unknown>>;

/** A command's answer, or what it threw: a race leg never leaves a rejection unhandled. */
export type Outcome = { readonly answer: CommandResult } | { readonly error: unknown };

export const settle = (call: Promise<CommandResult>): Promise<Outcome> =>
  call.then(
    (answer) => ({ answer }),
    (error: unknown) => ({ error }),
  );

/** One writer on a pool of its own, so no two racers queue on one connection. */
export interface Writer {
  send(member: Member, body: Body): Promise<CommandResult>;
  close(): Promise<void>;
}

export function writerOn(w: WayfinderWorld): Writer {
  const database: Database = connect(w.db.appUrl, { source: 'runtime' });
  return {
    send: async (member, body) =>
      await executeCommand(database, w.business, member.presented, 'api', {
        operationId: randomUUID(),
        ...body,
      } as never),
    close: async () => await database.close(),
  };
}

/** A map charted by `owner`: the grilling ticket `g` waits on every research ticket named. */
export async function chartBlocked(
  w: WayfinderWorld,
  owner: Member,
  blockers: readonly string[],
): Promise<{ readonly map: string; readonly tickets: Readonly<Record<string, string>> }> {
  const answer = await w.as(owner, {
    command: 'map.chart',
    title: `map ${randomUUID().slice(0, 8)}`,
    tickets: [
      ...blockers.map((ref) => ({ ref, title: `research ${ref}`, type: 'research' })),
      { ref: 'g', title: 'decide', type: 'grilling', blockedBy: blockers },
    ],
  });
  const made = must(answer, 'map.chart');
  const tickets = (answer as unknown as { detail: { tickets: Record<string, string> } }).detail
    .tickets;
  return { map: made.id, tickets };
}

/** Every decision item on `ticket`, in any business and state, oldest first. */
export async function decisionsOn(
  w: WayfinderWorld,
  ticket: string,
): Promise<
  readonly { readonly business: string; readonly recipient: string; readonly state: string }[]
> {
  return Array.from(
    await w.db.admin.execute<{ business: string; recipient: string; state: string }>(
      `select business_id::text as business, recipient_person_id::text as recipient,
              work_state as state
         from public.inbox_items where subject_record_id = $1 and reason = 'decision'
        order by raised_at, id`,
      [ticket],
    ),
    (row) => ({ ...row }),
  );
}

export async function onFrontier(w: WayfinderWorld, ticket: string): Promise<boolean> {
  const rows = await w.db.admin.execute('select 1 from public.map_frontier where ticket_id = $1', [
    ticket,
  ]);
  return rows.length === 1;
}

/** The key `map_summary_refresh` takes for one map, to the end of its transaction. */
export const mapRefreshKey = (business: string, map: string): string =>
  `map.summary:${business}:${map}`;

/** Holds an advisory key exclusively on a connection of its own until `letGo`. */
export async function holdKey(w: WayfinderWorld, key: string): Promise<Held> {
  return await hold(w.db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  });
}

/** The pids of the backends waiting on a lock `pid` holds, now. */
export async function waitingOn(w: WayfinderWorld, pid: number): Promise<readonly number[]> {
  const rows = await w.db.admin.execute<{ pid: number }>(
    `select a.pid from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'
        and $1::int = any(pg_blocking_pids(a.pid)) order by a.pid`,
    [pid],
  );
  return rows.map((row) => Number(row.pid));
}

/** Waits until `count` backends wait on a lock `pid` holds; answers their pids. */
export async function waitersOf(
  w: WayfinderWorld,
  pid: number,
  count: number,
): Promise<readonly number[]> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const pids = await waitingOn(w, pid);
    if (pids.length >= count) return pids;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`${count} waiters on ${pid} never appeared: the schedule was not established`);
}

/** A rollback a proof planned, told from a fault by its `what`. */
export class Planned extends Error {
  readonly what: 'held elsewhere' | 'not held' | 'rolled back';
  constructor(what: Planned['what']) {
    super(what);
    this.what = what;
  }
}

const planned = (error: unknown, what: Planned['what']): boolean =>
  error instanceof Planned && error.what === what;

/**
 * Whether an open decision item for `ticket` and `recipient` is held, still
 * uncommitted, by another transaction: a twin insert waits on it, and gives up
 * at the lock timeout. Rolled back either way.
 */
export async function uncommittedItemHeld(
  w: WayfinderWorld,
  ticket: string,
  recipient: string,
): Promise<boolean> {
  const probe = await hold(
    w.db,
    () => Promise.resolve(),
    async (execute) => {
      await execute(`set local lock_timeout = '300ms'`);
      try {
        await execute(
          `insert into public.inbox_items
           (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id,
            owed)
         values ($1, gen_random_uuid(), $2, $3, 'decision', 'record', $3, true)
         on conflict (business_id, recipient_person_id, subject_record_id, reason, fact_kind,
                      fact_id) where work_state = 'open' do nothing`,
          [w.business, recipient, ticket],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') throw new Planned('held elsewhere');
        throw error;
      }
      throw new Planned('not held');
    },
  );
  try {
    await probe.letGo();
  } catch (error) {
    if (planned(error, 'held elsewhere')) return true;
    if (planned(error, 'not held')) return false;
    throw error;
  }
  throw new Error('uncommittedItemHeld: the probe committed');
}

/** An open decision item for `ticket`, inserted and held uncommitted, as a twin raise holds it. */
export async function holdTwinItem(
  w: WayfinderWorld,
  ticket: string,
  recipient: string,
  outcome: 'commit' | 'roll back',
): Promise<Held> {
  return await hold(
    w.db,
    async (execute) => {
      await execute(
        `insert into public.inbox_items
           (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id,
            owed)
         values ($1, gen_random_uuid(), $2, $3, 'decision', 'record', $3, true)`,
        [w.business, recipient, ticket],
      );
    },
    outcome === 'roll back' ? () => Promise.reject(new Planned('rolled back')) : undefined,
  );
}

/** Lets a held transaction go, swallowing only its own planned rollback. */
export async function letTwinGo(twin: Held): Promise<void> {
  try {
    await twin.letGo();
  } catch (error) {
    if (!planned(error, 'rolled back')) throw error;
  }
}

/** Cancels a backend's current statement, which aborts its transaction. */
export async function cancel(w: WayfinderWorld, pid: number): Promise<void> {
  const [row] = await w.db.admin.execute<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [
    pid,
  ]);
  if (row?.ok !== true) throw new Error(`could not cancel backend ${pid}`);
}

type Execute = AdminConnection['execute'];

/**
 * One transaction on the owner's connection of its own, in the world's business:
 * the map read models' triggers run in it as they run under any write.
 */
export async function inBusinessTransaction<T>(
  w: WayfinderWorld,
  body: (execute: Execute) => Promise<T>,
): Promise<T> {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('inBusinessTransaction: no database server');
  const url = new URL(server);
  url.pathname = `/${w.db.name}`;
  const owner = connectAsAdmin(url.toString());
  try {
    return await owner.transaction(async (execute) => {
      await execute(`select set_config('app.business_id', $1, true)`, [w.business]);
      return await body(execute);
    });
  } finally {
    await owner.close();
  }
}

/** The `blocks` link from `blocker` to `ticket`, as a row to put back. */
export async function blockingLink(
  execute: Execute,
  blocker: string,
  ticket: string,
): Promise<string> {
  const [link] = await execute<{ readonly row: string }>(
    `select to_jsonb(l)::text as row from public.record_links l
      where l.link_type = 'blocks' and l.from_record_id = $1 and l.to_record_id = $2`,
    [blocker, ticket],
  );
  if (link === undefined) throw new Error('blockingLink: no such link');
  return link.row;
}

/** Unblocks the ticket: the link goes, the map is refreshed, the ticket lands. */
export async function unlink(execute: Execute, blocker: string, ticket: string): Promise<void> {
  await execute(
    `delete from public.record_links
      where link_type = 'blocks' and from_record_id = $1 and to_record_id = $2`,
    [blocker, ticket],
  );
}

/** Puts a link back: the map is refreshed, the ticket leaves the frontier. */
export async function relink(execute: Execute, row: string): Promise<void> {
  await execute(
    `insert into public.record_links select * from jsonb_populate_record(null::public.record_links, $1::text::jsonb)`,
    [row],
  );
}
