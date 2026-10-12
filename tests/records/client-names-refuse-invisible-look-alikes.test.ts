// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('invisiblenames', 1_000_000);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

async function client(name: string): Promise<unknown> {
  return await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
        [s.business, randomUUID(), name, s.decider.actorId],
      ),
  );
}

it('an invisible combining grapheme joiner cannot create a look-alike client', async () => {
  await client('Acme');
  await expect(client('Acme\u034F')).rejects.toMatchObject({ constraint_name: 'drawn_name_shape' });
});

it('a client name refuses an unbounded combining stack', async () => {
  await expect(client(`A${'\u0301'.repeat(190)}`)).rejects.toMatchObject({
    constraint_name: 'drawn_name_shape',
  });
});

it('a client name refuses a leading Hebrew combining mark', async () => {
  await expect(client('\u05B0Acme')).rejects.toMatchObject({ constraint_name: 'drawn_name_shape' });
});

it('a client name refuses an invisible Hangul filler', async () => {
  await expect(client('Acme\u3164')).rejects.toMatchObject({ constraint_name: 'drawn_name_shape' });
});
