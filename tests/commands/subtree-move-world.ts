// SPDX-License-Identifier: AGPL-3.0-only
//
// A world for racing `task.move` against creations under the moved subtree.
// Each creation is a transaction held open on its own connection: it holds its
// parent `for share` and has inserted its child, as `task.create` does, until
// the case commits it. The waits are witnessed through pg_blocking_pids.

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { Scope } from '../../packages/core-records/src/authority/grants.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { planTaskPlacement } from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';

type Request = Parameters<typeof executeCommand>[4];
export type Answer = Awaited<ReturnType<typeof executeCommand>>;

export interface World {
  readonly db: FreshDatabase;
  /** The mover's connection, and two more for creations held beside `db.app`. */
  readonly second: Database;
  readonly third: Database;
  readonly fourth: Database;
  readonly business: string;
  readonly worker: Member;
  readonly grantor: Member;
  readonly delegable: string;
}

let current: World | undefined;

const noop = (): void => undefined;

export interface Row {
  readonly board: unknown;
  readonly revision: number;
}

export function world(): World {
  if (current === undefined) throw new Error('subtree-move-world: not set up');
  return current;
}

export async function setUpWorld(name: string): Promise<World> {
  const db = await createFreshDatabase({ part: 'f' });
  const another = (): Database => connect(db.appUrl, { source: 'runtime' });
  const [second, third, fourth] = [another(), another(), another()];
  const business = await insertBusiness(db.app, name);
  await installSpine(db.app, business);
  const worker = await enrol(db.app, business, 'placer');
  const grantor = await enrol(db.app, business, 'grantor');
  const delegable = await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, worker, 'write');
    // `task.set_party` is declared under `share`, for the client cases.
    await grantTo(tx, worker, 'share');
    return await grantTo(tx, grantor, 'write', WHOLE_BUSINESS, true);
  });
  const made = { db, second, third, fourth, business, worker, grantor, delegable };
  current = made;
  return made;
}

export async function tearDownWorld(): Promise<void> {
  await Promise.all([current?.second.close(), current?.third.close(), current?.fourth.close()]);
  await current?.db.drop();
}

/** Run a command on `db.app` as `who` in `where`, refusing a refusal. */
export async function run(
  command: Readonly<Record<string, unknown>>,
  who: Member = world().worker,
  where: string = world().business,
): Promise<Answer> {
  const answer = await executeCommand(world().db.app, where, who.presented, 'api', {
    operationId: randomUUID(),
    ...command,
  } as unknown as Request);
  if (isCommandRefusal(answer)) throw new Error(`${String(command['command'])}: ${answer.code}`);
  return answer;
}

export async function create(
  extra: Readonly<Record<string, unknown>> = {},
  who: Member = world().worker,
  where: string = world().business,
): Promise<string> {
  const made = await run(
    { command: 'task.create', fields: { title: 'placed' }, ...extra },
    who,
    where,
  );
  return isCommandRefusal(made) ? '' : (made.recordId ?? '');
}

export async function read(recordId: string, where: string = world().business): Promise<Row> {
  return await world().db.app.withBusiness(where, async (tx) => {
    const rows = await tx.query<{
      readonly data: Record<string, unknown>;
      readonly revision: string;
    }>(`select data, revision::text as revision from records where business_id = $1 and id = $2`, [
      where,
      recordId,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error('read: gone');
    return { board: row.data['board'], revision: Number(row.revision) };
  });
}

/** Each record's board and revision, in order. */
export async function snapshot(
  ids: readonly string[],
  where: string = world().business,
): Promise<readonly Row[]> {
  const seen: Row[] = [];
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- read back in order
    seen.push(await read(id, where));
  }
  return seen;
}

/** A mover holding `write` on each scope named, cut from the grantor's delegable grant. */
export async function moverOn(
  name: string,
  scopes: readonly (string | Scope)[],
  expiresAt: Date | null = null,
): Promise<Member> {
  const { db, business, grantor, delegable } = world();
  const mover = await enrol(db.app, business, name);
  await db.app.withBusiness(business, async (tx) => {
    for (const scope of scopes) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      const derived = await issueGrant(tx, [{ kind: 'person', id: grantor.personId }], {
        subject: { kind: 'person', id: mover.personId },
        scope: typeof scope === 'string' ? { kind: 'record', id: scope } : scope,
        collection: 'task',
        action: 'write',
        parentGrantId: delegable,
        grantedByActorId: grantor.actorId,
        expiresAt: typeof scope === 'string' ? null : expiresAt,
      });
      if (!derived.ok) throw new Error(`moverOn: refused ${derived.refusal.code}`);
    }
  });
  return mover;
}

/** Wait until a backend is parked on a row lock one of `blockers` holds. */
export async function awaitRowWaitOn(
  blockers: readonly number[],
  deadline: number = Date.now() + 3_000,
): Promise<void> {
  const rows = await world().db.admin.execute<{ readonly pid: number }>(
    `select pid from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and wait_event <> 'advisory' and $1::int[] && pg_blocking_pids(pid)
      limit 1`,
    [blockers],
  );
  if (rows.length > 0) return;
  if (Date.now() > deadline) throw new Error('nothing waited: no interleaving was established');
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  await awaitRowWaitOn(blockers, deadline);
}

export interface Held {
  readonly pid: number;
  readonly commit: () => Promise<void>;
}

/** Holds a case has not committed, so a failed case does not park the next one. */
const open = new Set<() => Promise<void>>();

export async function releaseHeld(): Promise<void> {
  const left = [...open];
  open.clear();
  await Promise.allSettled(left.map(async (commit) => await commit()));
}

/**
 * A creation held open on `on`: its parent locked `for share` and, when
 * `child` is named, the child inserted (with `data` over the placed fields).
 */
export async function holdUnder(
  on: Database,
  parentId: string,
  child?: { readonly id: string; readonly data?: Readonly<Record<string, unknown>> },
  where: string = world().business,
): Promise<Held> {
  let release: () => void = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: (pid: number) => void = noop;
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const done = on.withBusiness(where, async (tx) => {
    const spine = await readTaskSpine(tx);
    const placement = await planTaskPlacement(tx, spine.taskTypeId, { parentId });
    if (isRecordsRefusal(placement)) throw new Error(placement.code);
    if (child !== undefined) await insertChild(tx, spine.taskTypeId, parentId, child, placement);
    ready(
      (await tx.query<{ readonly pid: number }>(`select pg_backend_pid() as pid`))[0]?.pid ?? 0,
    );
    await gate;
  });
  const pid = await Promise.race([started, done.then(() => 0)]);
  const commit = async (): Promise<void> => {
    open.delete(commit);
    release();
    await done;
  };
  open.add(commit);
  return { pid, commit };
}

async function insertChild(
  tx: TenantQuery,
  typeId: string,
  parent: string,
  child: { readonly id: string; readonly data?: Readonly<Record<string, unknown>> },
  placement: { readonly board: string | null },
): Promise<void> {
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [
      tx.businessId,
      child.id,
      typeId,
      {
        title: 'committed meanwhile',
        key: `T-${900_000 + Math.floor(Math.random() * 99_999)}`,
        parent,
        ...(placement.board === null ? {} : { board: placement.board }),
        ...child.data,
      },
    ],
  );
}

/** Start `mover`'s move of `root` to `board` on the second connection. */
export function startMove(
  mover: Member,
  root: string,
  expectedRevision: number,
  board: string,
): Promise<Answer> {
  const { second, business } = world();
  return executeCommand(second, business, mover.presented, 'api', {
    command: 'task.move',
    operationId: randomUUID(),
    recordId: root,
    expectedRevision,
    board,
  } as unknown as Request);
}
