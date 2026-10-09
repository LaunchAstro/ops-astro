// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { executeCommand, runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, withSession } from '../../packages/core-records/src/index.ts';
import { latch } from '../support/lock-wait-race.ts';
import { entryIdOf, type TimeWorld } from './time-world.ts';

async function atDoor(w: TimeWorld, operationId: string): Promise<number> {
  const identity = createHash('sha256').update(operationId).digest('hex');
  const door = `operation:${w.alpha}:${w.clientA.actorId}:${identity}`;
  const rows = await w.db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from pg_locks l,
       (select hashtextextended($1, 0) as k) h
     where l.locktype = 'advisory' and not l.granted and l.objsubid = 1
       and l.classid::bigint = (h.k >> 32) & 4294967295
       and l.objid::bigint = h.k & 4294967295`,
    [door],
  );
  return rows[0]?.n ?? 0;
}
export async function registered(w: TimeWorld, operationId: string): Promise<number[]> {
  const rows = await w.db.admin.execute<{ readonly operations: number; readonly applied: number }>(
    `select
       (select count(*)::int from public.operations where business_id = $1
         and actor_id = $2 and operation_id = $3) as operations,
       (select count(*)::int from public.audit_events where business_id = $1
         and actor_id = $2 and operation_id = $3 and outcome = 'applied') as applied`,
    [w.alpha, w.clientA.actorId, operationId],
  );
  return [rows[0]?.operations ?? -1, rows[0]?.applied ?? -1];
}
interface PendingPair {
  readonly request: Readonly<{ command: 'time.start'; taskId: string; operationId: string }>;
  readonly tentative: string;
  readonly original: Readonly<{ result: unknown; error: unknown }>;
  readonly result: Awaited<ReturnType<typeof executeCommand>>;
}
export async function pendingPair(
  w: TimeWorld,
  taskId: string,
  rollback: boolean,
): Promise<PendingPair> {
  const request = { command: 'time.start', taskId, operationId: randomUUID() } as const;
  const ready = latch<string>();
  const released = latch();
  const caller = connect(w.db.appUrl);
  const first = withSession(w.db.app, w.alpha, w.clientA.presented, async (tx, session) => {
    const result = await runCommand(tx, session, 'api', request, w.clientA.presented);
    ready.open(entryIdOf(result));
    await released.promise;
    if (rollback) throw new Error('synthetic rollback after Start registration');
    return result;
  });
  const observed = first.then(
    (result) => ({ result, error: null }),
    (error: unknown) => ({ result: null, error }),
  );
  let retry: ReturnType<typeof executeCommand> | null = null;
  try {
    const tentative = await Promise.race([
      ready.promise,
      observed.then(() => {
        throw new Error('Start ended before its held transaction was established');
      }),
    ]);
    expect(await registered(w, request.operationId)).toEqual([0, 0]);
    expect(await w.entries(taskId)).toEqual([]);
    retry = executeCommand(caller, w.alpha, w.clientA.presented, 'api', request);
    void retry.catch(() => {});
    await expect.poll(async () => await atDoor(w, request.operationId)).toBe(1);
    released.open();
    const original = await observed;
    const result = await retry;
    return { request, tentative, original, result };
  } finally {
    released.open();
    await observed;
    await retry?.catch(() => {});
    await caller.close();
  }
}
