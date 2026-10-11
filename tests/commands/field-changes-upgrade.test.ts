// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115) upgrade: a business whose chain was written before the field
// names existed keeps every event and hash as it was. Its old events stay
// NULL, which reads as "not known", and are never filled in with guessed
// names; the next writes chain on with their names, and the chain verifies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  readAuditEvents,
  verifyAuditChain,
  writeAuditEvent,
} from '../../packages/core-commands/src/commands/audit.ts';
import { payloadDigest } from '../../packages/core-digest/src/digest.ts';
import { made, update } from './field-changes-world.ts';

const FIELD_CHANGES = '20261011034325_audit_field_changes';
const configured = databaseUrlFromEnvironment() !== undefined;

// eslint-disable-next-line max-lines-per-function -- one database, its one upgrade case
describe.skipIf(!configured)('P20 upgrade of an existing chain', () => {
  let db: EmptyDatabase;
  let business: string;
  let writer: Member;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'p20_upgrade' });
    const migrations = readMigrations('migrations');
    const index = migrations.findIndex((m) => m.version === FIELD_CHANGES);
    if (index <= 0) throw new Error('the field-changes migration is not after an installed prefix');
    await applyMigrations(db.admin, migrations.slice(0, index));
    business = await insertBusiness(db.app, `p20-upgrade-${randomUUID()}`);
    await installSpine(db.app, business);
    writer = await enrol(db.app, business, 'p20-upgrade-writer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, writer, 'write');
    });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  const send = async (body: Record<string, unknown>) =>
    await executeCommand(db.app, business, writer.presented, 'api', body as never);

  // eslint-disable-next-line max-lines-per-function -- before, the migration, and after, in order
  it('keeps old events and hashes, leaves them unknown, and chains the new names on', async () => {
    const task = made(
      await send({ command: 'task.create', operationId: randomUUID(), fields: { title: 'same' } }),
    );
    // An applied update as the old schema wrote it: a digest and no names.
    await db.app.withBusiness(business, (tx) =>
      writeAuditEvent(tx, {
        actorId: writer.actorId,
        command: 'task.update',
        operationId: randomUUID(),
        subjectRecordId: task.recordId,
        outcome: 'applied',
        payloadDigest: payloadDigest({ title: 'legacy' }),
      }),
    );
    const before = await db.app.withBusiness(business, readAuditEvents);

    await db.closeSessions();
    const migrations = readMigrations('migrations');
    const migrated = await applyMigrations(db.admin, migrations);
    expect(migrated.applied).toStrictEqual(
      migrations.map((m) => m.version).filter((version) => version >= FIELD_CHANGES),
    );

    const after = await db.app.withBusiness(business, readAuditEvents);
    expect(after.map((a) => [a.seq, a.prev_hash, a.hash])).toStrictEqual(
      before.map((a) => [a.seq, a.prev_hash, a.hash]),
    );
    const old = await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.audit_events
        where business_id = $1 and field_changes is not null`,
      [business],
    );
    expect(old[0]?.n).toBe(0);

    const same = update(task, { title: 'same' });
    const unchanged = made(await send(same));
    const renamed = update(unchanged, { title: 'after' });
    await send(renamed);
    const written = await db.admin.execute<{ readonly field_changes: unknown }>(
      `select field_changes from public.audit_events
        where business_id = $1 and operation_id = any($2::text[]) order by seq`,
      [business, [same.operationId, renamed.operationId]],
    );
    expect(written.map((row) => row.field_changes)).toStrictEqual([
      { version: 1, keys: [] },
      { version: 1, keys: ['title'] },
    ]);
    expect(await db.app.withBusiness(business, verifyAuditChain)).toMatchObject({
      intact: true,
      length: before.length + 2,
    });
  });
});
