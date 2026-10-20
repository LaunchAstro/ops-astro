// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import {
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  admin,
  alpha,
  clientB,
  clientBPerson,
  db,
  fresh,
  revisionOf,
  serverUrl,
  setUp,
  SHARE,
  tearDown,
} from '../commands/client-access-world.ts';
import { gate, waitingOn } from '../support/lock-waits.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
});
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

it.skipIf(serverUrl === undefined)(
  'shareRecord racing Client access completes both calls without a lock-order deadlock',
  // eslint-disable-next-line max-lines-per-function -- a proof kept as its reviewer wrote it
  async () => {
    const recordId = await fresh(alpha, admin, 'lock-order race', clientB);
    const expectedRevision = await revisionOf(recordId);
    const commandConnection = connect(db.appUrl);
    const helperConnection = connect(db.appUrl);
    const taskHeld = gate();
    const continueCommand = gate();
    let paused = false;
    const wrap = (tx: TransactionQuery): TransactionQuery => ({
      ...tx,
      async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
        const rows = await tx.query<Row>(text, parameters);
        if (
          !paused &&
          text.includes('from records') &&
          text.includes('for update') &&
          parameters?.includes(recordId)
        ) {
          paused = true;
          taskHeld.release();
          await continueCommand.promise;
        }
        return rows;
      },
      async savepoint(work): Promise<boolean> {
        return await tx.savepoint(async (inner) => await work(wrap(inner)));
      },
    });
    const watched: Database = {
      ...commandConnection,
      async withBusiness(businessId, run) {
        return await commandConnection.withBusiness(businessId, async (tx) => await run(wrap(tx)));
      },
    };
    const commanded = executeCommand(watched, alpha, admin.presented, 'api', {
      command: SHARE,
      operationId: randomUUID(),
      recordId,
      expectedRevision,
    });
    const observed: Promise<object>[] = [commanded];
    try {
      await taskHeld.promise;
      const helper = helperConnection.withBusiness(
        alpha,
        async (tx) =>
          await shareRecord(tx, admin, {
            collection: 'task',
            recordId,
            personId: clientBPerson.personId,
          }),
      );
      observed.push(helper);
      await waitingOn(db.admin, 'transactionid', 'for share of r');
    } finally {
      continueCommand.release();
    }
    try {
      const answers = await Promise.allSettled(observed);
      const failures = answers.flatMap((answer) => {
        if (answer.status === 'rejected') return [String(answer.reason)];
        if (isCommandRefusal(answer.value)) return [answer.value.code];
        return [];
      });
      expect(failures).toEqual([]);
      expect(answers).toHaveLength(2);
    } finally {
      await Promise.all([commandConnection.close(), helperConnection.close()]);
    }
  },
  30_000,
);
