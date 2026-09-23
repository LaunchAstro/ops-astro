// SPDX-License-Identifier: AGPL-3.0-only
//
// What a task command's payload may carry, and what it may not.
//
// Every case here is negative except two, which is the point: a Tier 3 change
// with no negative case has not been tested where it matters (round contract,
// E2), and for this part "where it matters" is the protected-field boundary.
// Each `TRANSITION_PROTECTED` below is a side door that would otherwise be
// open through the generic editor.
//
// The companion file, `task-lifecycle.test.ts`, carries the cases about what a
// command *does*: the state, the placement, the trash and the audit event
// T1e handed on. They are two files because the per-file cap is 400
// hand-written lines and no waiver lifts it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { PROTECTED_TASK_FIELDS } from '../../packages/core-records/src/tasks/spine.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task commands: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('the task commands: what a payload may carry', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let grants: Record<string, string>;

  const run = async (command: Parameters<typeof executeCommand>[4], who: Member = worker) =>
    await executeCommand(db.app, business, who.presented, 'api', command);

  const create = async (
    fields: Readonly<Record<string, unknown>>,
    extra: Readonly<Record<string, unknown>> = {},
  ) => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields,
      ...extra,
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return made;
  };

  const read = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{
        readonly data: Record<string, unknown>;
        readonly revision: string;
        readonly ts_2: Date | null;
        readonly uuid_5: string | null;
        readonly uuid_6: string | null;
      }>(
        `select data, revision::text as revision, ts_2, uuid_5, uuid_6 from records
            where business_id = $1 and id = $2`,
        [business, recordId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('read: gone');
      return row;
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'task-commands');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    grants = await db.app.withBusiness(business, async (tx) => ({
      write: await grantTo(tx, worker, 'write'),
      assign: await grantTo(tx, worker, 'assign'),
      share: await grantTo(tx, worker, 'share'),
      manage: await grantTo(tx, worker, 'manage'),
    }));
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('the generic editor cannot perform a transition', () => {
    // The code each of the eleven earns, asserted by name rather than by rule,
    // so relaxing one is a visible diff (minimum contract 5.3 assertion 2).
    // Three kinds, and the difference between them is the point: a field an
    // operation owns names that operation, a derived field names nobody
    // because no operation takes it as an input, and `source` is a claim of
    // authority rather than a write. `intake_state` on update names
    // `task.triage` (the root's D03 ruling; it is `SOURCE_SPOOFED` on create).
    const EXPECTED: Readonly<Record<string, string>> = {
      assignee: 'TRANSITION_PROTECTED',
      client: 'TRANSITION_PROTECTED',
      client_visible: 'TRANSITION_PROTECTED',
      completed_at: 'FIELD_NOT_WRITABLE',
      delegate: 'TRANSITION_PROTECTED',
      intake_state: 'TRANSITION_PROTECTED',
      key: 'FIELD_NOT_WRITABLE',
      parent: 'TRANSITION_PROTECTED',
      source: 'SOURCE_SPOOFED',
      stage: 'TRANSITION_PROTECTED',
      state: 'TRANSITION_PROTECTED',
    };

    it('refuses each protected field by name, with the code the field earns', async () => {
      const made = await create({ title: 'protected' });
      const refusals: Record<string, string> = {};
      for (const field of PROTECTED_TASK_FIELDS) {
        // oxlint-disable-next-line no-await-in-loop
        const refusal = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
          fields: { [field]: randomUUID() },
        });
        refusals[field] = isCommandRefusal(refusal) ? refusal.code : 'APPLIED';
      }
      expect(refusals).toStrictEqual(EXPECTED);
      // Every field the spine calls protected has a case above. A twelfth
      // field added to that list with no entry here fails this line.
      expect(Object.keys(EXPECTED).toSorted()).toStrictEqual([...PROTECTED_TASK_FIELDS].toSorted());
    });

    it('names the owning operation, so the caller knows what to call instead', async () => {
      const made = await create({ title: 'named' });
      const refusal = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { assignee: worker.personId },
      });
      expect(isCommandRefusal(refusal) && refusal.names).toStrictEqual(['assignee=task.assign']);
    });

    it('refuses a derived field rather than overwriting it', async () => {
      const made = await create({ title: 'derived' });
      const refusal = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { completed_at: new Date(0).toISOString() },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('FIELD_NOT_WRITABLE');
    });

    it('refuses a claim of provenance under its own code', async () => {
      const refusal = await run({
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'accepted already', intake_state: 'accepted' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('SOURCE_SPOOFED');
    });

    it('keeps the key and the source the server’s own', async () => {
      const made = await create({ title: 'derived provenance' });
      const row = await read(made.recordId ?? '');
      expect(row.data['source']).toBe('person:api');
      expect(row.data['key']).toMatch(/^T-\d+$/u);
    });
  });

  describe('the operations that own a field', () => {
    it('writes the fields its name owns', async () => {
      const made = await create({ title: 'assignable' });
      const assigned = await run({
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { assignee: worker.personId },
      });
      expect(isCommandRefusal(assigned)).toBe(false);
      const row = await read(made.recordId ?? '');
      expect(row.data['assignee']).toBe(worker.personId);
    });

    it('refuses a field it does not own, naming the command that does', async () => {
      const made = await create({ title: 'not mine to write' });
      const refusal = await run({
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { title: 'renamed by the wrong command' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('TRANSITION_PROTECTED');
      expect(isCommandRefusal(refusal) && refusal.names).toStrictEqual(['title=task.update']);
    });

    it('checks the action the operation needs, not just any grant', async () => {
      const made = await create({ title: 'needs assign' });
      await db.app.withBusiness(business, async (tx) => {
        await revokeGrant(tx, grants['assign'] ?? '');
      });
      const refusal = await run({
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { assignee: worker.personId },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('SCOPE_NOT_GRANTED');
      // And the write grant still covers task.update, so what was refused was
      // the action and not the caller.
      const updated = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { title: 'still editable' },
      });
      expect(isCommandRefusal(updated)).toBe(false);
    });
  });
});

// A value of the wrong type is a refusal and not a fault. Without this the
// projection trigger casts it, raises, and the caller gets a fault where the
// contract promises a typed refusal — and the audit records the attempt as
// `failed` rather than as the refusal it was.
describe.skipIf(serverUrl === undefined)('a value that is not of the field’s type', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'value-types');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'typist');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'assign');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const run = async (command: Parameters<typeof executeCommand>[4]) =>
    await executeCommand(db.app, business, worker.presented, 'api', command);

  it('refuses a label where a link belongs, naming the type the field is', async () => {
    const refusal = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'mistyped', due: 'next tuesday' },
    });
    expect(isCommandRefusal(refusal) && refusal.code).toBe('FIELD_VALUE_INVALID');
    expect(isCommandRefusal(refusal) && refusal.names).toStrictEqual(['due=timestamptz']);
  });

  it('refuses it on an owning operation too, not only on the generic ones', async () => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'assignable' },
    });
    if (isCommandRefusal(made)) throw new Error('create refused');
    const refusal = await run({
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: made.recordId ?? '',
      expectedRevision: made.revision ?? 0,
      fields: { assignee: 'a person’s name, not their identifier' },
    });
    expect(isCommandRefusal(refusal) && refusal.code).toBe('FIELD_VALUE_INVALID');
  });

  it('records the refusal as refused, not as failed', async () => {
    await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'audited mistype', priority: 'high' },
    });
    const events = await db.app.withBusiness(business, readAuditEvents);
    expect(events.at(-1)?.outcome).toBe('refused');
    expect(events.at(-1)?.refusal_code).toBe('FIELD_VALUE_INVALID');
  });
});
