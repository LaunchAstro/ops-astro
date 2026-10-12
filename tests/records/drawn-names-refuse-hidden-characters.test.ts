// SPDX-License-Identifier: AGPL-3.0-only
//
// A client's name and a connection's label are drawn on screens every member
// with the key can open, so neither may hide text or pass for another. A
// connection's label takes the signal grammar (`signal_text`, 20261005201200).
// A client's name stays open to every script, but refuses control, format
// (direction overrides, zero-width and tag characters), private-use and
// unassigned characters, line separators, variation selectors and a leading
// combining mark.
// Each write is the owner's, so the refusal is the table's, whoever writes.
// A stored row either refuses stops the upgrade, named by id, and is kept.

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
  s = await openSchedules('drawnnames', 1_000_000);
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

async function client(name: string): Promise<unknown> {
  return await s.db.admin.execute(
    'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
    [s.business, randomUUID(), name, s.decider.actorId],
  );
}

async function connection(label: string): Promise<unknown> {
  return await s.db.admin.execute(
    `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
     values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
    [s.business, randomUUID(), label],
  );
}

it.each(hidden)("a client's name with %s is refused", async (_what, name) => {
  await expect(client(name)).rejects.toMatchObject({ constraint_name: 'drawn_name_shape' });
});

it("a client's name in any script, with a combining mark inside a word, is written", async () => {
  for (const name of [
    'Ōtautahi Traders',
    '東京商事',
    'Ελληνικά Ltd',
    'Jose\u0301 & Co',
    'Café Noël',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await expect(client(name), name).resolves.toBeDefined();
  }
});

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

it('an upgrade over a stored hidden name stops, naming the row, and rewrites nothing', async () => {
  const db = await createEmptyDatabase({ part: 'drawnnamesup' });
  try {
    await applyMigrations(
      db.admin,
      readMigrations('migrations').filter((m) => m.version < '20261012052116'),
    );
    const business = randomUUID();
    const actor = randomUUID();
    const named = randomUUID();
    const labelled = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)',
      [business, 'drawnnamesup'],
    );
    await db.admin.execute(
      `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
      [business, actor],
    );
    await db.admin.execute(
      'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
      [business, named, 'Acme\u{E0041}', actor],
    );
    await db.admin.execute(
      `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
       values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
      [business, labelled, 'Acme\uFE0F'],
    );
    await db.closeSessions();
    // The runner names the migration; the database's own refusal is its cause.
    const stopped = await migrate(db.admin, 'migrations').then(
      () => undefined,
      (error: unknown) => (error as Error).cause as Error | undefined,
    );
    expect(stopped?.message).toBe(
      `drawn names: rename these rows first; clients ${named}, connections ${labelled}`,
    );
    const [kept] = await db.admin.execute<{ readonly name: string }>(
      'select name from public.clients where id = $1',
      [named],
    );
    expect(kept?.name).toBe('Acme\u{E0041}');
  } finally {
    await db.drop();
  }
}, 180_000);
