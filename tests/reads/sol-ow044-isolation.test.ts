// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { alpha, CANARY, dropSteps, ids, owner, pairReader, seed, seeded } from './steps-world.ts';

beforeAll(seed, 180_000);
afterAll(dropSteps);

async function observedRead() {
  const received: string[] = [];
  const app = seeded().app;
  const observed: Database = {
    log: app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: tx.savepoint,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            return rows;
          },
        };
        return await run(watched);
      }),
  };
  const answer = await executeRead(observed, alpha, pairReader.presented, {
    read: 'task.read',
    recordId: ids['parent'] ?? '',
  });
  expect('task' in answer).toBe(true);
  if (!('task' in answer)) throw new Error('parent read was refused');
  expect(answer.task.steps.map((step) => step.id)).toEqual([ids['first']]);
  return { answer, received: received.join('\n') };
}

it('Sol proof, criterion 2: client to client child text never leaves Postgres for a restricted reader', async () => {
  const control = await executeRead(seeded().app, alpha, owner.presented, {
    read: 'task.read',
    recordId: ids['stray'] ?? '',
  });
  expect(JSON.stringify(control)).toContain(CANARY);
  const { answer, received } = await observedRead();
  expect(JSON.stringify(answer)).not.toContain(CANARY);
  expect(received, 'other client child title was returned to the serving process').not.toContain(
    CANARY,
  );
});

it('Sol proof, criterion 2: person to person a parent grant never reads an ungranted child title', async () => {
  const control = await executeRead(seeded().app, alpha, owner.presented, {
    read: 'task.read',
    recordId: ids['second'] ?? '',
  });
  expect(JSON.stringify(control)).toContain('Check the forms');
  const { answer, received } = await observedRead();
  expect(JSON.stringify(answer)).not.toContain('Check the forms');
  expect(received, 'ungranted child title was returned to the serving process').not.toContain(
    'Check the forms',
  );
});
