// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations L2 made possible, against a real Postgres.
//
// Every case here is one the frontier map names — I09 (the comment projection),
// I13 (reads audited), D05 (a real preset plan) and D06 (system-field injection
// against every payload this lane adds) — and each asserts the observed code
// rather than that something went wrong, for the reason the slice test gives:
// a test that only checks a call failed passes when it fails for the wrong
// reason.
//
// The positive control beside each negative is not decoration. "The database is
// unchanged" is only evidence when the same assertion, run on the accepted
// payload, shows it changing.

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
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import type { ReadRequest } from '../../packages/core-records/src/reads/requests.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('surface operations: DATABASE_URL is unset, so nothing below ran.');
}

type Command = Parameters<typeof executeCommand>[4];

describe.skipIf(serverUrl === undefined)('the operations L2 made possible', () => {
  let db: FreshDatabase;
  let alpha: string;
  /** Everything: task, preset and settings authority. The positive control. */
  let mia: Member;
  /** A real member of alpha with no grant at all. */
  let noah: Member;
  let taskId: string;
  let taskRevision: number;

  const run = async (command: Command, who: Member = mia) =>
    await executeCommand(db.app, alpha, who.presented, 'api', command);
  const read = async (request: ReadRequest, who: Member = mia) =>
    await executeRead(db.app, alpha, who.presented, request);

  const countRows = async (table: 'field_defs' | 'business_settings' | 'audit_events') =>
    await db.app.withBusiness(alpha, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        `select count(*)::text as n from ${table} where business_id = $1`,
        [tx.businessId],
      );
      return Number(rows[0]?.n ?? '0');
    });

  const auditFor = async (command: string) =>
    await db.app.withBusiness(alpha, async (tx) => {
      const rows = await tx.query<{
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly operation_id: string | null;
      }>(
        `select outcome, refusal_code, operation_id from audit_events
          where business_id = $1 and command = $2 order by seq`,
        [tx.businessId, command],
      );
      return rows;
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l3' });
    alpha = await insertBusiness(db.app, 'alpha');
    await installSpine(db.app, alpha);
    await db.app.withBusiness(alpha, async (tx) => {
      await installBusinessSettings(tx);
    });
    mia = await enrol(db.app, alpha, 'mia');
    noah = await enrol(db.app, alpha, 'noah');
    await db.app.withBusiness(alpha, async (tx) => {
      for (const action of ['read', 'write', 'comment', 'share'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, mia, action);
      }
      // `preset.plan` takes `manage` on the family it plans, not a blanket
      // `manage` on `preset`: L2's planner checks the family of the request's
      // `recordTypeKey` and the surface now asks the same question. These
      // cases plan the `task` family, so that is the grant they need.
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'task');
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
    });

    const created = await run({
      command: 'task.create',
      operationId: `create-${randomUUID()}`,
      fields: { title: 'A task to talk about' },
    });
    if (isCommandRefusal(created)) throw new Error(`setup refused ${created.code}`);
    taskId = created.recordId ?? '';
    taskRevision = created.revision ?? 0;
  }, 60_000);

  afterAll(async () => await db?.drop());

  describe('task.comment is a real command (I09)', () => {
    it('writes a comment, leaving the task at the revision the caller holds', async () => {
      const result = await run({
        command: 'task.comment',
        operationId: `comment-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'An internal note',
        audience: 'internal',
      });
      expect(isCommandRefusal(result)).toBe(false);
      if (isCommandRefusal(result)) return;
      expect(result.revision).toBe(taskRevision);
      expect(result.detail['commentId']).toEqual(expect.any(String));
    });

    it('refuses an audience the model does not have, and writes nothing', async () => {
      const before = await countRows('audit_events');
      const result = await run({
        command: 'task.comment',
        operationId: `comment-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'To whom',
        audience: 'the-public',
      });
      expect(isCommandRefusal(result) && result.code).toBe('FIELD_VALUE_INVALID');
      // The refusal is still an attempt, so it is still one audit event.
      expect(await countRows('audit_events')).toBe(before + 1);
    });

    it('a member with no comment grant is refused SCOPE_NOT_GRANTED', async () => {
      const result = await run(
        {
          command: 'task.comment',
          operationId: `comment-${randomUUID()}`,
          recordId: taskId,
          expectedRevision: taskRevision,
          body: 'Not mine to write',
          audience: 'internal',
        },
        noah,
      );
      expect(isCommandRefusal(result) && result.code).toBe('SCOPE_NOT_GRANTED');
    });

    it('task.read carries the comments in full for an internal reader', async () => {
      await run({
        command: 'task.comment',
        operationId: `comment-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'For the client',
        audience: 'client',
        commentType: 'client',
      });
      const result = await read({ read: 'task.read', recordId: taskId });
      expect('task' in result).toBe(true);
      if (!('task' in result)) return;
      const bodies = result.task.comments.map((comment) => comment['body']);
      expect(bodies).toContain('An internal note');
      expect(bodies).toContain('For the client');
      // The internal reader sees the internal fields too.
      expect(result.task.comments[0]).toHaveProperty('source');
    });
  });

  describe('preset.plan is a real operation (D05)', () => {
    const validField = {
      key: 'campaign_code',
      label: 'Campaign code',
      valueType: 'text',
      writeMode: 'generic',
    };

    it('a valid plan comes back, and no field definition is written', async () => {
      const before = await countRows('field_defs');
      const result = await read({
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [validField],
      });
      expect('plan' in result).toBe(true);
      if (!('plan' in result)) return;
      expect(result.plan.presetKey).toBe('marketing');
      expect(result.plan.actions).toEqual([
        { action: 'create_field', key: 'campaign_code', slot: expect.any(String) },
      ]);
      expect(await countRows('field_defs')).toBe(before);
    });

    it('an unclassified field refuses PRESET_FIELD_UNCLASSIFIED, naming it', async () => {
      const before = await countRows('field_defs');
      const result = await read({
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [validField, { key: 'undecided', label: 'Undecided', valueType: 'text' }],
      });
      expect(isCommandRefusal(result) && result.code).toBe('PRESET_FIELD_UNCLASSIFIED');
      expect(isCommandRefusal(result) && result.names).toContain('undecided');
      expect(await countRows('field_defs')).toBe(before);
    });

    it('a member with no preset grant is refused SCOPE_NOT_GRANTED', async () => {
      const result = await read(
        { read: 'preset.plan', recordTypeKey: 'task', presetKey: 'marketing', fields: [] },
        noah,
      );
      expect(isCommandRefusal(result) && result.code).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('the settings operations', () => {
    const valueOf = async (key: string) =>
      await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly value: unknown }>(
          `select value from business_settings where business_id = $1 and key = $2`,
          [tx.businessId, key],
        );
        return rows[0]?.value;
      });

    it('sets the four-eyes band, and null turns it off', async () => {
      const set = await run({
        command: 'settings.set_four_eyes_threshold',
        operationId: `four-${randomUUID()}`,
        value: 1200,
      });
      expect(isCommandRefusal(set)).toBe(false);
      expect(await valueOf('four_eyes_threshold')).toBe(1200);

      await run({
        command: 'settings.set_four_eyes_threshold',
        operationId: `four-${randomUUID()}`,
        value: null,
      });
      expect(await valueOf('four_eyes_threshold')).toBeNull();
    });

    it('sets client sign-off, and refuses a value of the wrong type unchanged', async () => {
      const set = await run({
        command: 'settings.set_client_sign_off',
        operationId: `sign-${randomUUID()}`,
        value: true,
      });
      expect(isCommandRefusal(set) ? set.code : 'applied').toBe('applied');
      expect(await valueOf('client_sign_off_required')).toBe(true);

      const refusedValue = await run({
        command: 'settings.set_client_sign_off',
        operationId: `sign-${randomUUID()}`,
        value: 'yes' as unknown as boolean,
      });
      expect(isCommandRefusal(refusedValue) && refusedValue.code).toBe('FIELD_VALUE_INVALID');
      expect(await valueOf('client_sign_off_required')).toBe(true);
    });

    it('a member without settings authority is refused SCOPE_NOT_GRANTED', async () => {
      const result = await run(
        {
          command: 'settings.set_client_sign_off',
          operationId: `sign-${randomUUID()}`,
          value: false,
        },
        noah,
      );
      expect(isCommandRefusal(result) && result.code).toBe('SCOPE_NOT_GRANTED');
      expect(await valueOf('client_sign_off_required')).toBe(true);
    });
  });

  describe('reads are audited (I13)', () => {
    it('one successful task.read and one refused read leave exactly one event each', async () => {
      const before = (await auditFor('task.read')).length;
      const ok = await read({ read: 'task.read', recordId: taskId });
      expect('task' in ok).toBe(true);
      const denied = await read({ read: 'task.read', recordId: taskId }, noah);
      expect(isCommandRefusal(denied) && denied.code).toBe('SCOPE_NOT_GRANTED');

      const events = await auditFor('task.read');
      expect(events.length).toBe(before + 2);
      const [applied, refused] = events.slice(-2);
      expect(applied?.outcome).toBe('applied');
      expect(applied?.refusal_code).toBeNull();
      // A read carries no identity, because it has nothing to replay.
      expect(applied?.operation_id).toBeNull();
      expect(refused?.outcome).toBe('refused');
      expect(refused?.refusal_code).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('system-field injection against every payload this lane adds (D06)', () => {
    const SYSTEM_FIELDS = {
      business_id: randomUUID(),
      actor_id: randomUUID(),
      created_at: '1999-01-01T00:00:00.000Z',
      revision: 99,
    };

    it('task.comment: refused or ignored, with the database unchanged', async () => {
      const before = await countRows('audit_events');
      const result = await run({
        command: 'task.comment',
        operationId: `spoof-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'Spoofed',
        audience: 'internal',
        ...SYSTEM_FIELDS,
      } as unknown as Command);
      // Either answer discharges D06: what may not happen is the value landing.
      if (!isCommandRefusal(result)) {
        const detail = await read({ read: 'task.read', recordId: taskId });
        expect('task' in detail && detail.task.revision).toBe(taskRevision);
      }
      expect(await countRows('audit_events')).toBeGreaterThan(before);
      // The positive control: the same payload without the system fields.
      const control = await run({
        command: 'task.comment',
        operationId: `control-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'Not spoofed',
        audience: 'internal',
      });
      expect(isCommandRefusal(control)).toBe(false);
    });

    it('settings.set_four_eyes_threshold: the injected actor is not the recorded one', async () => {
      await run({
        command: 'settings.set_four_eyes_threshold',
        operationId: `spoof-${randomUUID()}`,
        value: 750,
        ...SYSTEM_FIELDS,
      } as unknown as Command);
      const row = await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly updated_by_actor_id: string | null }>(
          `select updated_by_actor_id from business_settings
            where business_id = $1 and key = 'four_eyes_threshold'`,
          [tx.businessId],
        );
        return rows[0];
      });
      expect(row?.updated_by_actor_id).not.toBe(SYSTEM_FIELDS.actor_id);
      // The positive control: it really did write, and as the real actor.
      expect(row?.updated_by_actor_id).toBe(mia.actorId);
    });

    it('settings.set_client_sign_off: an injected revision reaches nothing', async () => {
      const before = await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly updated_at: Date }>(
          `select updated_at from business_settings
            where business_id = $1 and key = 'client_sign_off_required'`,
          [tx.businessId],
        );
        return rows[0]?.updated_at;
      });
      const result = await run({
        command: 'settings.set_client_sign_off',
        operationId: `spoof-${randomUUID()}`,
        value: false,
        ...SYSTEM_FIELDS,
      } as unknown as Command);
      const row = await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{
          readonly value: unknown;
          readonly updated_by_actor_id: string | null;
          readonly updated_at: Date;
        }>(
          `select value, updated_by_actor_id, updated_at from business_settings
            where business_id = $1 and key = 'client_sign_off_required'`,
          [tx.businessId],
        );
        return rows[0];
      });
      // `revision` and `created_at` are not columns of this table and not
      // fields of this command, so there is nowhere for them to land; what the
      // case proves is that the actor and the time stayed the server's.
      expect(row?.updated_by_actor_id).not.toBe(SYSTEM_FIELDS.actor_id);
      expect(row?.updated_by_actor_id).toBe(mia.actorId);
      expect(row?.updated_at.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
      expect(new Date(SYSTEM_FIELDS.created_at).getTime()).toBeLessThan(
        row?.updated_at.getTime() ?? 0,
      );
      // The positive control: the write itself landed.
      expect(isCommandRefusal(result)).toBe(false);
      expect(row?.value).toBe(false);
    });

    it('preset.plan: a field carrying system keys still plans nothing into them', async () => {
      const before = await countRows('field_defs');
      const result = await read({
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [{ key: 'spoofed', label: 'Spoofed', valueType: 'text', writeMode: 'generic' }],
        ...SYSTEM_FIELDS,
      } as unknown as ReadRequest);
      expect(await countRows('field_defs')).toBe(before);
      // The positive control: the plan itself came back.
      expect('plan' in result).toBe(true);
    });
  });
});
