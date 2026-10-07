// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openSchedules } from './schedules-harness.ts';
import {
  s,
  other,
  insert,
  child,
  conversationCall,
  seedRunRows,
  setSchedules,
  CROSS_RUN,
} from './run-side-rows-fixture.ts';
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  setSchedules(await openSchedules('runbound', 1_000_000));
  await seedRunRows();
}, 60_000);

afterAll(async () => {
  await s?.db.drop();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'run-side rows stay with their run',
  () => {
    it.each(CROSS_RUN)(
      "%s refuses another run's %s as the application role",
      async (table, column) => {
        await expect(
          insert(table, { ...child(table), [column]: other[column] }),
        ).rejects.toMatchObject({
          code: '23503',
        });
      },
    );

    it.each(['bootstrap_reads', 'run_checks', 'model_calls'])(
      '%s accepts references within the same run as the application role',
      async (table) => {
        await expect(insert(table, child(table))).resolves.toBeUndefined();
      },
    );
  },
);
describe.skipIf(databaseUrlFromEnvironment() === undefined)('optional run references', () => {
  it('accepts a conversation call with null run references as the application role', async () => {
    const conversationId = randomUUID();
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
         values ($1, $2, $3, $4, 'Local conversation')`,
        [s.business, conversationId, s.decider.actorId, s.decider.personId],
      );
    });
    await expect(insert('model_calls', conversationCall(conversationId))).resolves.toBeUndefined();
  });

  it('accepts an entry bootstrap read without a step as the application role', async () => {
    await expect(
      insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: null, is_entry: true }),
    ).resolves.toBeUndefined();
  });
});
