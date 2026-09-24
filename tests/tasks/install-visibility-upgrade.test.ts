// SPDX-License-Identifier: AGPL-3.0-only
//
// SURFACE-R-1: a business installed before 77bcc54 acquires the I09 shared title and state.
//
// Before 77bcc54 no spine field declared a visibility class, so every task
// field installed `internal`, and the installer returned early on an existing
// task type without reading its fields. A business seeded then kept title and
// state internal through every later reseed, and its client's read of a shared
// task answered `fields: {}` against Nathan's I09 ruling.
//
// The earlier shape is built the way install-upgrade.test.ts builds Base: run
// the current installer, then put back the one thing the old one wrote
// differently. 77bcc54 changed spine.ts by two `visibilityClass: 'shared'`
// lines and nothing else, so resetting those two rows to `internal` is that
// shape exactly.
//
// Three assertions carry the finding. The ordinary idempotent install brings
// title and state to their declaration, and the client's read then shows the
// title and the state's label. Every other field row, every custom
// classification (a core field an admin shared, a preset field) and every task
// row is byte-identical. A second call writes nothing. A fresh business reads
// the same way.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { readSharedTask } from '../../packages/core-records/src/reads/tasks.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

const TITLE = 'a task shared before the I09 ruling';

/** Every field row of the business, whole, so a column this file did not think of is still compared. */
async function fieldRows(tx: TenantQuery): Promise<Readonly<Record<string, unknown>>> {
  const rows = await tx.query<{ readonly id: string; readonly row: Record<string, unknown> }>(
    `select id, to_jsonb(f) as row from field_defs f where business_id = $1 order by id`,
    [tx.businessId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.row]));
}

async function recordRows(tx: TenantQuery): Promise<readonly unknown[]> {
  const rows = await tx.query<{ readonly row: unknown }>(
    `select to_jsonb(r) as row from records r where business_id = $1 order by id`,
    [tx.businessId],
  );
  return rows.map((r) => r.row);
}

async function classOf(tx: TenantQuery, typeId: string, key: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly visibility_class: string }>(
    `select visibility_class from field_defs where record_type_id = $1 and key = $2`,
    [typeId, key],
  );
  return rows[0]?.visibility_class;
}

async function insertTask(tx: TenantQuery, taskTypeId: string, stateId: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [tx.businessId, id, taskTypeId, { title: TITLE, state: stateId, description: 'team only' }],
  );
  return id;
}

describe.skipIf(serverUrl === undefined)(
  'installTaskSpine brings an installed spine to the I09 shared title and state',
  () => {
    let db: FreshDatabase;
    let upgraded: string;
    let fresh: string;

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'l2v' });
      upgraded = await insertBusiness(db.app, 'pre-i09');
      fresh = await insertBusiness(db.app, 'post-i09');
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('reconciles exactly title and state on an existing spine, and is stable on a second call', async () => {
      await db.app.withBusiness(upgraded, async (tx) => {
        // 1. The pre-77bcc54 shape: the current install with title and state
        //    put back to internal, which is all the old installer did differently.
        const first = await installTaskSpine(tx);
        await tx.query(
          `update field_defs set visibility_class = 'internal'
            where record_type_id = $1 and key in ('title', 'state')`,
          [first.taskTypeId],
        );
        // Custom classifications the reconcile must not touch: a core field an
        // admin shared and a preset field of either class.
        await tx.query(
          `update field_defs set visibility_class = 'shared'
            where record_type_id = $1 and key = 'description'`,
          [first.taskTypeId],
        );
        for (const [key, visibility] of [
          ['client_ref', 'shared'],
          ['team_note', 'internal'],
        ] as const) {
          // oxlint-disable-next-line no-await-in-loop
          await tx.query(
            `insert into field_defs
               (business_id, id, record_type_id, key, label, value_type, write_mode,
                visibility_class, origin)
             values ($1, $2, $3, $4, $4, 'text', 'generic', $5, 'preset')`,
            [tx.businessId, randomUUID(), first.taskTypeId, key, visibility],
          );
        }
        const stateId = first.stateIds['active']!;
        const taskId = await insertTask(tx, first.taskTypeId, stateId);

        // The finding, as the client sees it before the upgrade.
        const before = await readSharedTask(tx, first.taskTypeId, taskId, first.taskCommentTypeId);
        expect(before?.fields).not.toHaveProperty('title');
        expect(before?.fields).not.toHaveProperty('state');

        const fieldsBefore = await fieldRows(tx);
        const recordsBefore = await recordRows(tx);

        // 2. The ordinary idempotent install, as the seed runs it.
        const again = await installTaskSpine(tx);
        expect(again.installed).toBe(false);
        expect(again.taskTypeId).toBe(first.taskTypeId);

        expect(await classOf(tx, first.taskTypeId, 'title')).toBe('shared');
        expect(await classOf(tx, first.taskTypeId, 'state')).toBe('shared');

        // Nothing else moved: every other field row whole, and every record.
        const fieldsAfter = await fieldRows(tx);
        const changed = Object.keys(fieldsAfter).filter(
          (id) => JSON.stringify(fieldsAfter[id]) !== JSON.stringify(fieldsBefore[id]),
        );
        expect(
          changed.map((id) => (fieldsAfter[id] as { key: string }).key).toSorted(),
        ).toStrictEqual(['state', 'title']);
        for (const id of changed) {
          expect({
            ...(fieldsAfter[id] as object),
            visibility_class: 'internal',
          }).toStrictEqual(fieldsBefore[id]);
        }
        expect(Object.keys(fieldsAfter).toSorted()).toStrictEqual(
          Object.keys(fieldsBefore).toSorted(),
        );
        expect(await classOf(tx, first.taskTypeId, 'description')).toBe('shared');
        expect(await classOf(tx, first.taskTypeId, 'client_ref')).toBe('shared');
        expect(await classOf(tx, first.taskTypeId, 'team_note')).toBe('internal');
        expect(await recordRows(tx)).toStrictEqual(recordsBefore);

        const label = (
          await tx.query<{ readonly label: string }>(
            `select data ->> 'label' as label from records where id = $1`,
            [stateId],
          )
        )[0]?.label;
        const after = await readSharedTask(tx, first.taskTypeId, taskId, first.taskCommentTypeId);
        expect(after?.fields).toMatchObject({ title: TITLE, state: label });
        expect(JSON.stringify(after)).not.toContain(stateId);

        // 3. Stability: a second run writes nothing at all.
        const third = await installTaskSpine(tx);
        expect(third).toStrictEqual(again);
        expect(await fieldRows(tx)).toStrictEqual(fieldsAfter);
        expect(await recordRows(tx)).toStrictEqual(recordsBefore);
      });
    }, 60_000);

    it('a fresh business installs title and state shared and its client reads them', async () => {
      await db.app.withBusiness(fresh, async (tx) => {
        const spine = await installTaskSpine(tx);
        expect(spine.installed).toBe(true);
        const stateId = Object.values(spine.stateIds)[0]!;
        const label = (
          await tx.query<{ readonly label: string }>(
            `select data ->> 'label' as label from records where id = $1`,
            [stateId],
          )
        )[0]?.label;
        const taskId = await insertTask(tx, spine.taskTypeId, stateId);
        const view = await readSharedTask(tx, spine.taskTypeId, taskId, spine.taskCommentTypeId);
        expect(view?.fields).toStrictEqual({ title: TITLE, state: label });

        const fieldsBefore = await fieldRows(tx);
        expect(await installTaskSpine(tx)).toMatchObject({ installed: false });
        expect(await fieldRows(tx)).toStrictEqual(fieldsBefore);
      });
    }, 60_000);
  },
);
