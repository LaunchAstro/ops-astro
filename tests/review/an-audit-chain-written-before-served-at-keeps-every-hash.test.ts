// SPDX-License-Identifier: AGPL-3.0-only
//
// #2370 upgrade: a business whose audit chain was written before `served_at` existed keeps
// every event and hash as it was, with no snapshot time filled in after the fact; a task read
// after the upgrade names its snapshot time and the chain verifies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { made } from '../commands/field-changes-world.ts';

const SERVED_AT = '20261114140700_audit_served_at';
const configured = databaseUrlFromEnvironment() !== undefined;

// eslint-disable-next-line max-lines-per-function -- one database, its one upgrade case
describe.skipIf(!configured)('the served_at upgrade of an existing chain', () => {
  let db: EmptyDatabase;
  let business: string;
  let writer: Member;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'a2370_upgrade' });
    const migrations = readMigrations('migrations');
    const index = migrations.findIndex((m) => m.version === SERVED_AT);
    if (index <= 0) throw new Error('the served_at migration is not after an installed prefix');
    await applyMigrations(db.admin, migrations.slice(0, index));
    business = await insertBusiness(db.app, `a2370-upgrade-${randomUUID()}`);
    await installSpine(db.app, business);
    writer = await enrol(db.app, business, 'a2370-upgrade-writer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, writer, 'write');
      await grantTo(tx, writer, 'read');
    });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  const send = async (body: Record<string, unknown>) =>
    await executeCommand(db.app, business, writer.presented, 'api', body as never);

  // eslint-disable-next-line max-lines-per-function -- before, the migration, and after, in order
  it('keeps old events and hashes, fills in no snapshot time, and chains a task read on', async () => {
    const task = made(
      await send({ command: 'task.create', operationId: randomUUID(), fields: { title: 'old' } }),
    );
    await send({ command: 'task.create', operationId: randomUUID(), fields: { title: 'older' } });
    const before = await db.app.withBusiness(business, readAuditEvents);
    expect(before.length).toBeGreaterThan(1);

    await db.closeSessions();
    const migrations = readMigrations('migrations');
    const migrated = await applyMigrations(db.admin, migrations);
    expect(migrated.applied).toStrictEqual(
      migrations.map((m) => m.version).filter((version) => version >= SERVED_AT),
    );

    const after = await db.app.withBusiness(business, readAuditEvents);
    expect(after.map((a) => [a.seq, a.prev_hash, a.hash])).toStrictEqual(
      before.map((a) => [a.seq, a.prev_hash, a.hash]),
    );
    const filled = await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.audit_events
        where business_id = $1 and served_at is not null`,
      [business],
    );
    expect(filled[0]?.n).toBe(0);
    expect(await db.app.withBusiness(business, verifyAuditChain)).toMatchObject({
      intact: true,
      length: before.length,
    });

    await executeRead(db.app, business, writer.presented, {
      read: 'task.read',
      recordId: task.recordId,
    } as never);
    const read = await db.admin.execute<{ readonly served_at: Date | null }>(
      `select served_at from public.audit_events
        where business_id = $1 and command = 'task.read' order by seq desc limit 1`,
      [business],
    );
    expect(read[0]?.served_at).toBeInstanceOf(Date);
    expect(await db.app.withBusiness(business, verifyAuditChain)).toMatchObject({
      intact: true,
      length: before.length + 1,
    });
  });
});
