// SPDX-License-Identifier: AGPL-3.0-only
//
// A connection's label is drawn on screens every member with the key can
// open, so it may not hide text or pass for another: it takes the signal
// grammar (`signal_text`, 20261005201200). Each write is the owner's, so the
// refusal is the table's, whoever writes. A stored label outside it stops the
// upgrade, named by id, and is kept.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { createEmptyDatabase } from '../support/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('connectionlabels', 1_000_000);
}, 180_000);

afterAll(async () => {
  if (noDatabase) return;
  await s.db.drop();
});

const hidden = [
  ['a direction override', 'Acme\u202E Ltd'],
  ['a zero-width space', 'Ac\u200Bme'],
  ['a tag character', 'Acme\u{E0041}'],
  ['an Arabic number sign', 'Acme\u0600'],
  ['a control character', 'Ac\u0007me'],
  ['a private-use character', 'Acme\uE000'],
  ['an unassigned code point', 'Acme\u0378'],
  ['a line separator', 'Acme\u2028Ltd'],
  ['a variation selector', 'Acme\uFE0F'],
  ['a supplementary variation selector', 'Acme\u{E0100}'],
  ['a leading combining mark', '\u0301Acme'],
] as const;

async function connection(label: string): Promise<unknown> {
  return await s.db.admin.execute(
    `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
     values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
    [s.business, randomUUID(), label],
  );
}

it.each(hidden)("a connection's label with %s is refused", async (_what, label) => {
  await expect(connection(label)).rejects.toMatchObject({ constraint_name: 'signal_text_shape' });
});

it("a connection's label outside the signal grammar is refused, and one inside it is written", async () => {
  await expect(connection('東京 ledger')).rejects.toMatchObject({
    constraint_name: 'signal_text_shape',
  });
  await expect(connection(' Xero')).rejects.toMatchObject({ constraint_name: 'signal_text_shape' });
  await expect(connection('Xero – main ledger (AU)')).resolves.toBeDefined();
});

it('an upgrade over a stored hidden label stops, naming the row, and rewrites nothing', async () => {
  const db = await createEmptyDatabase({ part: 'labelsup' });
  try {
    await applyMigrations(
      db.admin,
      readMigrations('migrations').filter((m) => m.version < '20261012052116'),
    );
    const business = randomUUID();
    const labelled = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)',
      [business, 'labelsup'],
    );
    await db.admin.execute(
      `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
       values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
      [business, labelled, 'Acme\uFE0F'],
    );
    await db.closeSessions();
    // The runner names the migration; the database's own refusal is its cause.
    const stopped = await migrate(db.admin, 'migrations').then(
      () => new Error('the upgrade went through'),
      (error: unknown) => (error as Error).cause as Error,
    );
    expect(stopped.message).toBe(`connection labels: rename these rows first; ${labelled}`);
    const [kept] = await db.admin.execute<{ readonly label: string }>(
      'select label from public.connections where id = $1',
      [labelled],
    );
    expect(kept?.label).toBe('Acme\uFE0F');
  } finally {
    await db.drop();
  }
}, 180_000);
