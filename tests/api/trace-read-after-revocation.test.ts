// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { liveWork, openSchedules } from '../runtime/schedules-harness.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

// eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
it('a trace read under way when task read is revoked serves no trace', async () => {
  const s = await openSchedules('tracereadrace', 1_000_000);
  const reader = connect(s.db.appUrl);
  const reached = latch();
  const resume = latch();
  const paused: Database = {
    log: reader.log,
    close: () => reader.close(),
    withBusiness: (business, run) =>
      reader.withBusiness(business, (tx) =>
        run({
          ...tx,
          async query<Row>(
            statement: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> {
            if (statement.includes('as exported')) {
              reached.release();
              await resume.promise;
            }
            return await tx.query<Row>(statement, parameters);
          },
        }),
      ),
  };
  let reading: ReturnType<typeof executeRead> | undefined;
  try {
    const work = await liveWork(s, 'trace read race', 1_000);
    const runId = String(work.picked['runId']);
    const ops = await enrol(s.db.app, s.business, 'ops');
    const grantId = await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, ops, 'read', undefined, false, 'operations');
      return await grantTo(tx, ops, 'read', { kind: 'record', id: work.taskId });
    });
    const read = { read: 'trace.read', recordId: work.taskId } as never;
    const before = await executeRead(s.db.app, s.business, ops.presented, read);
    expect(JSON.stringify(before)).toContain(runId);
    reading = executeRead(paused, s.business, ops.presented, read);
    await reached.promise;
    await s.db.admin.execute('update public.grants set revoked_at = now() where id = $1', [
      grantId,
    ]);
    resume.release();
    const after = await reading;
    expect(after).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(after)).not.toContain(runId);
  } finally {
    resume.release();
    await reading;
    await reader.close();
    await s.db.drop();
  }
}, 180_000);
