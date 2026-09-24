// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared half of the W01, W03, W05 and heartbeat schedules.
//
// Every operation here goes through the production command entry: a person's
// body through `executeCommand`, an agent's through `executeAgentCommand`, the
// same two functions the HTTP boundary mounts. The runtime-helper tests beside
// this file call `propose` and `handback` directly, and that is exactly how the
// outer lock inversion in the proposal adapter went unseen: the adapter's task
// lock is taken before the runtime's sorted set, so only a call through the
// adapter can meet it.
//
// **Ordering is forced and observed, never slept through.** A third connection
// holds a row lock the racers need; each racer is started only once the one
// before it is *seen* parked on the named table in `pg_locks`; then the holder
// lets go. PostgreSQL grants a contended row in the order its waiters queued,
// so the order the schedule names is the order the server serves. A schedule
// that cannot establish its interleaving throws rather than passing quietly.
//
// Each racer gets its own connection. `connect` defaults to a pool of one, so
// two calls through one `Database` would queue in the client and never meet in
// the server, and the case would prove nothing about the schedule it names.

import { randomUUID } from 'node:crypto';
import { createServer, connect as connectSocket, type Server, type Socket } from 'node:net';
import {
  createFreshDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  connect,
  type BusinessId,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

export type Body = Readonly<Record<string, unknown>>;
export type Detail = Readonly<Record<string, unknown>>;

export interface Schedules {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly decider: Member;
  readonly agent: VerifiedSubject;
  readonly agentActorId: string;
  readonly capId: string;
}

/**
 * A business with a person who may decide, an agent that may pick up, and one
 * finite synthetic cap. The limit is the fixture's, never a production budget.
 */
export async function openSchedules(part: string, capLimitMinor: number): Promise<Schedules> {
  process.env['GATE_SIGNING_KEY_ID'] = `test/schedules-${part}@1`;
  process.env['GATE_SIGNING_SECRET'] = randomUUID();
  const db = await createFreshDatabase({ part });
  const business = (await insertBusiness(db.app, `schedules-${part}`)) as BusinessId;
  await installSpine(db.app, business);
  const decider = await enrol(db.app, business, 'decider');
  const capId = randomUUID();
  const agentActorId = randomUUID();
  const subject = `agent-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action, undefined, true);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', $3, 'AUD')`,
      [business, capId, capLimitMinor],
    );
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agentActorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, agentActorId, decider.actorId],
    );
  });
  return {
    db,
    business,
    decider,
    agent: { provider: 'supabase', subject },
    agentActorId,
    capId,
  };
}

/** A connection of its own, so its transaction is a backend of its own. */
export function racer(s: Schedules, url: string = s.db.appUrl): Database {
  return connect(url, { source: 'racer' });
}

export async function asPerson(
  s: Schedules,
  body: Body,
  database: Database = s.db.app,
): Promise<CommandResult> {
  return await executeCommand(database, s.business, s.decider.presented, 'api', body as never);
}

export async function asAgent(
  s: Schedules,
  body: Body,
  credential?: string,
  database: Database = s.db.app,
): Promise<CommandResult> {
  return (await executeAgentCommand(
    database,
    s.business,
    s.agent,
    credential,
    body as never,
  )) as CommandResult;
}

/** The detail of an applied result, or a throw naming the refusal. */
export function appliedDetail(result: CommandResult, what: string): Detail {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return result.detail as Detail;
}

export const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'applied';

export async function createTask(s: Schedules, title: string): Promise<string> {
  const outcome = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  if (isCommandRefusal(outcome) || outcome.recordId === null) {
    throw new Error(`task.create did not apply: ${codeOf(outcome)}`);
  }
  return outcome.recordId;
}

export async function revisionOf(s: Schedules, recordId: string): Promise<number> {
  return await scalar(
    s,
    `select revision::text as n from public.records where business_id = $1 and id = $2`,
    [s.business, recordId],
  );
}

export interface ProposeOptions {
  readonly lineageId?: string;
  readonly maximumMinor?: number;
  /**
   * One agent holds one live delegation per purpose, so each piece of live
   * work in a suite is given a purpose of its own (`delegations.ts`,
   * `DELEGATION_ALREADY_LIVE`).
   */
  readonly purpose?: string;
}

let purposes = 0;

/** A purpose no other work in this process has used. */
export function freshPurpose(): string {
  purposes += 1;
  return `schedule_${String(purposes)}`;
}

export function proposeBody(
  recordId: string,
  expectedRevision: number,
  options: ProposeOptions = {},
): Body {
  return {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId,
    expectedRevision,
    purpose: options.purpose ?? 'draft_the_reply',
    maximumMinor: options.maximumMinor ?? 2_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply to the client' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
    ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
  };
}

export async function propose(
  s: Schedules,
  recordId: string,
  options: ProposeOptions = {},
): Promise<Detail> {
  const body = proposeBody(recordId, await revisionOf(s, recordId), options);
  return appliedDetail(await asPerson(s, body), 'task.propose');
}

export function approveBody(proposal: Detail): Body {
  return {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: proposal['gateId'],
    versionId: proposal['versionId'],
    decision: 'approve',
    note: 'approved for the schedule',
  };
}

export async function approve(s: Schedules, proposal: Detail): Promise<Detail> {
  return appliedDetail(await asPerson(s, approveBody(proposal)), 'task.decide');
}

export async function pickup(
  s: Schedules,
  reservationId: unknown,
  leaseSeconds = 600,
): Promise<Detail> {
  const result = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds,
  });
  return appliedDetail(result, 'task.pickup');
}

/** Proposed, approved and picked up: the live work a handback settles. */
export interface Work {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly decision: Detail;
  readonly picked: Detail;
}

export async function liveWork(s: Schedules, title: string, maximumMinor: number): Promise<Work> {
  const taskId = await createTask(s, title);
  const proposal = await propose(s, taskId, { maximumMinor, purpose: freshPurpose() });
  const decision = await approve(s, proposal);
  const picked = await pickup(s, decision['reservationId']);
  return { taskId, proposal, decision, picked };
}

export function handbackBody(picked: Detail, successor?: Body): Body {
  return {
    command: 'task.handback',
    operationId: randomUUID(),
    leaseId: picked['leaseId'],
    fence: picked['fence'],
    outcome: 'completed',
    report: { summary: 'drafted' },
    actualMinor: null,
    ...(successor === undefined ? {} : { successor }),
  };
}

export async function scalar(
  s: Schedules,
  text: string,
  parameters: readonly unknown[],
): Promise<number> {
  const found = await s.db.admin.execute<{ readonly n: string | null }>(text, parameters as never);
  return Number(found[0]?.n ?? 0);
}

export async function rows<Row>(
  s: Schedules,
  text: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  return await s.db.admin.execute<Row>(text, parameters as never);
}

/** The cap's committed total, summed from the envelopes that draw on it. */
export async function capCommitted(s: Schedules): Promise<number> {
  return await scalar(
    s,
    `select coalesce(sum(held_minor + actual_minor), 0)::text as n
       from public.task_envelopes where business_id = $1 and cap_id = $2`,
    [s.business, s.capId],
  );
}

export async function envelopeHeld(s: Schedules, taskId: string): Promise<number> {
  return await scalar(
    s,
    `select held_minor::text as n from public.task_envelopes
      where business_id = $1 and task_id = $2`,
    [s.business, taskId],
  );
}

/** A promise the test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface Holder {
  /** Commit the holder's transaction, letting the parked racers through in queue order. */
  release(): Promise<void>;
}

/**
 * Hold row locks on a third connection until released. It writes nothing; it
 * only takes `for update` on rows that already exist, so letting go changes no
 * state a racer could read.
 */
export async function holdRows(
  s: Schedules,
  table: string,
  ids: readonly string[],
): Promise<Holder> {
  const database = racer(s);
  const locked = barrier();
  const gate = barrier();
  const done = database.withBusiness(s.business, async (tx) => {
    for (const id of ids) {
      // One row at a time, in the order given: the holder's own order is not
      // under test, only the rows it keeps.
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        `select 1 from public.${table} where business_id = $1 and id = $2 for update`,
        [s.business, id],
      );
    }
    locked.release();
    await gate.held;
  });
  await locked.held;
  return {
    async release() {
      gate.release();
      await done;
      await database.close();
    },
  };
}

/**
 * Wait until `count` backends are parked on a row lock in `table`. A waiter
 * holds or queues for the tuple lock of the row it asked for, which is what
 * tells "parked at acquisition on this table" from any other wait.
 *
 * `table` may instead be `advisory`: the business decision-chain lock
 * (`locks.ts`, class `chain`), which `task.decide` takes before the cap.
 */
export async function awaitParked(s: Schedules, table: string, count: number): Promise<void> {
  const text =
    table === 'advisory'
      ? `select count(distinct a.pid)::text as n
           from pg_stat_activity a
           join pg_locks l on l.pid = a.pid and l.locktype = 'advisory' and not l.granted
          where a.datname = current_database() and a.wait_event_type = 'Lock'`
      : `select count(distinct a.pid)::text as n
           from pg_stat_activity a
           join pg_locks l on l.pid = a.pid and l.locktype = 'tuple'
           join pg_class c on c.oid = l.relation
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and c.relname = $1`;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const parked = await scalar(s, text, table === 'advisory' ? [] : [table]);
    if (parked >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error(
    `fewer than ${String(count)} backends ever parked on ${table}: the schedule was not established`,
  );
}

/** Poll the database clock, never the test's, until it is past `expiresSql`. */
export async function waitPast(s: Schedules, expiresSql: string, id: unknown): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const found = await rows<{ readonly past: boolean }>(
      s,
      `select clock_timestamp() > (${expiresSql}) as past`,
      [id],
    );
    if (found[0]?.past === true) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('the deadline never passed on the database clock');
}

/** The parked command's own transaction began before the deadline it is judged against. */
export async function startedBefore(
  s: Schedules,
  expiresSql: string,
  id: unknown,
): Promise<boolean> {
  const found = await rows<{ readonly before: boolean }>(
    s,
    `select bool_and(a.xact_start < (${expiresSql})) as before
       from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'`,
    [id],
  );
  return found[0]?.before === true;
}

/** Settle every racer before asserting, so a failed schedule reports rather than hangs. */
export async function settle<T>(
  racers: readonly Promise<T>[],
): Promise<readonly PromiseSettledResult<T>[]> {
  return await Promise.allSettled(racers);
}

/** A rejected racer's reason as text, for an assertion message that says what happened. */
export function reasonOf(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'fulfilled';
  const reason = result.reason as { readonly code?: unknown; readonly message?: unknown };
  return `${String(reason.code ?? '')} ${String(reason.message ?? result.reason)}`.trim();
}

/** Where a cut proxy drops the connection, named by what the server has done. */
export type CutPoint = 'before-commit' | 'after-commit';

export interface CutProxy {
  /** The application URL, routed through the proxy. */
  readonly url: string;
  /** Whether the proxy has cut the connection at its point. */
  cut(): boolean;
  close(): Promise<void>;
}

/**
 * A byte-for-byte TCP relay that kills the connection at a named point.
 *
 * `before-commit`: the client's `commit` request is never delivered. The
 * server sees the connection end inside an open transaction and rolls it back.
 * `after-commit`: the server's `COMMIT` completion is never delivered. The
 * server has committed; the caller only sees its connection die.
 *
 * The driver runs with `prepare: false`, so every statement's text travels in
 * its Parse message after an empty statement name: `\0commit\0`, which no
 * other statement's text contains. The completion is the `COMMIT` command tag.
 */
export async function cutProxy(targetUrl: string, point: CutPoint): Promise<CutProxy> {
  const target = new URL(targetUrl);
  const sockets = new Set<Socket>();
  let cut = false;
  const clientNeedle = Buffer.from('\0commit\0', 'latin1');
  const serverNeedle = Buffer.from('COMMIT\0', 'latin1');

  const server: Server = createServer((client) => {
    const upstream = connectSocket(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    const kill = (): void => {
      cut = true;
      client.destroy();
      upstream.destroy();
    };
    client.on('data', (chunk: Buffer) => {
      if (point === 'before-commit' && !cut && chunk.includes(clientNeedle)) {
        kill();
        return;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (point === 'after-commit' && !cut && chunk.includes(serverNeedle)) {
        kill();
        return;
      }
      client.write(chunk);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no port');
  const url = new URL(targetUrl);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    cut: () => cut,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
