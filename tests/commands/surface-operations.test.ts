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
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
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

  const countRows = async (
    table: 'field_defs' | 'business_settings' | 'audit_events' | 'records',
  ) =>
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
    // The contract is a **typed refusal and unchanged domain state**
    // (CONTRACT-LEDGER D06), not "refused or ignored". These cases said either
    // answer would do and the weaker one was what the boundary gave: the
    // fields were dropped and the ordinary mutation went through, so a caller
    // who believed they had set `actor_id` got a success and no correction.
    // Each case below now requires the refusal, requires the domain state to
    // be exactly what it was, and carries its own positive control so a
    // boundary that refused everything could not pass.
    const SYSTEM_FIELDS = {
      business_id: randomUUID(),
      actor_id: randomUUID(),
      created_at: '1999-01-01T00:00:00.000Z',
      revision: 99,
    };

    const readSetting = async (key: string) =>
      await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{
          readonly value: unknown;
          readonly updated_by_actor_id: string | null;
          readonly updated_at: Date;
        }>(
          `select value, updated_by_actor_id, updated_at from business_settings
            where business_id = $1 and key = $2`,
          [tx.businessId, key],
        );
        return rows[0];
      });

    const commentCount = async () =>
      await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly n: string }>(
          `select count(*)::text as n from records r
             join record_types t on t.business_id = r.business_id and t.id = r.record_type_id
            where r.business_id = $1 and t.key = 'task_comment'`,
          [tx.businessId],
        );
        return Number(rows[0]?.n ?? '0');
      });

    /** The refusal and the audit row it left, for one injected payload. */
    const injectAndAudit = async (command: Command, operationId: string) => {
      const result = await run(command);
      const events = await db.app.withBusiness(alpha, async (tx) => {
        const all = await readAuditEvents(tx);
        return all.filter((event) => event.operation_id === operationId);
      });
      return { result, events };
    };

    it('task.comment: refused, no comment written, and the ordinary payload still works', async () => {
      const before = await commentCount();
      const operationId = `spoof-${randomUUID()}`;
      const { result, events } = await injectAndAudit(
        {
          command: 'task.comment',
          operationId,
          recordId: taskId,
          expectedRevision: taskRevision,
          body: 'Spoofed',
          audience: 'internal',
          ...SYSTEM_FIELDS,
        } as unknown as Command,
        operationId,
      );
      expect(isCommandRefusal(result)).toBe(true);
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');
      // The names are the keys, so an author can see which ones to remove.
      expect(isCommandRefusal(result) ? [...result.names].toSorted() : []).toStrictEqual([
        'actor_id',
        'business_id',
        'created_at',
        'revision',
      ]);
      // Unchanged domain state: no comment, and the task's own revision stands.
      expect(await commentCount()).toBe(before);
      const detail = await read({ read: 'task.read', recordId: taskId });
      expect('task' in detail && detail.task.revision).toBe(taskRevision);
      // Recorded through the envelope's audit path like every other refusal.
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe('refused');
      expect(events[0]?.refusal_code).toBe('FIELD_NOT_WRITABLE');

      const control = await run({
        command: 'task.comment',
        operationId: `control-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'Not spoofed',
        audience: 'internal',
      });
      expect(isCommandRefusal(control)).toBe(false);
      expect(await commentCount()).toBe(before + 1);
    });

    it('settings.set_four_eyes_threshold: refused, and the stored setting is untouched', async () => {
      const control = await run({
        command: 'settings.set_four_eyes_threshold',
        operationId: `control-${randomUUID()}`,
        value: 750,
      });
      expect(isCommandRefusal(control)).toBe(false);
      const before = await readSetting('four_eyes_threshold');
      expect(before?.updated_by_actor_id).toBe(mia.actorId);

      const operationId = `spoof-${randomUUID()}`;
      const { result, events } = await injectAndAudit(
        {
          command: 'settings.set_four_eyes_threshold',
          operationId,
          value: 1_250,
          ...SYSTEM_FIELDS,
        } as unknown as Command,
        operationId,
      );
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');
      const after = await readSetting('four_eyes_threshold');
      // The value the injected payload also carried did not land, which is the
      // half the old case could not see: it only checked the actor.
      expect(after?.value).toStrictEqual(before?.value);
      expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
      expect(after?.updated_by_actor_id).toBe(mia.actorId);
      expect(events[0]?.refusal_code).toBe('FIELD_NOT_WRITABLE');
    });

    it('settings.set_client_sign_off: refused, and the stored setting is untouched', async () => {
      const control = await run({
        command: 'settings.set_client_sign_off',
        operationId: `control-${randomUUID()}`,
        value: false,
      });
      expect(isCommandRefusal(control)).toBe(false);
      const before = await readSetting('client_sign_off_required');
      expect(before?.value).toBe(false);

      const operationId = `spoof-${randomUUID()}`;
      const { result, events } = await injectAndAudit(
        {
          command: 'settings.set_client_sign_off',
          operationId,
          value: true,
          ...SYSTEM_FIELDS,
        } as unknown as Command,
        operationId,
      );
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');
      const after = await readSetting('client_sign_off_required');
      expect(after?.value).toBe(false);
      expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
      expect(after?.updated_by_actor_id).toBe(mia.actorId);
      expect(events[0]?.refusal_code).toBe('FIELD_NOT_WRITABLE');
    });

    it('task.propose and task.decide: the same refusal, and no proposal opened', async () => {
      const before = await countRows('audit_events');
      const proposeId = `spoof-${randomUUID()}`;
      const proposed = await run({
        command: 'task.propose',
        operationId: proposeId,
        recordId: taskId,
        expectedRevision: taskRevision,
        purpose: 'draft_the_reply',
        maximumMinor: 1_000,
        currency: 'AUD',
        payload: {},
        step: { kind: 'compose', payload: {} },
        ...SYSTEM_FIELDS,
      } as unknown as Command);
      expect(isCommandRefusal(proposed) ? proposed.code : '').toBe('FIELD_NOT_WRITABLE');

      const lineages = await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly n: string }>(
          `select count(*)::text as n from public.proposal_lineages
            where business_id = $1 and task_id = $2`,
          [tx.businessId, taskId],
        );
        return Number(rows[0]?.n ?? '0');
      });
      expect(lineages).toBe(0);

      const decided = await run({
        command: 'task.decide',
        operationId: `spoof-${randomUUID()}`,
        gateId: randomUUID(),
        versionId: randomUUID(),
        decision: 'approve',
        note: 'no',
        ...SYSTEM_FIELDS,
      } as unknown as Command);
      expect(isCommandRefusal(decided) ? decided.code : '').toBe('FIELD_NOT_WRITABLE');
      // Both refusals are on the trail, like every other refusal.
      expect(await countRows('audit_events')).toBeGreaterThan(before + 1);
    });

    it('task.pickup and task.handback: refused at the boundary before the agent path', async () => {
      for (const command of [
        {
          command: 'task.pickup',
          operationId: `spoof-${randomUUID()}`,
          reservationId: randomUUID(),
          ...SYSTEM_FIELDS,
        },
        {
          command: 'task.handback',
          operationId: `spoof-${randomUUID()}`,
          leaseId: randomUUID(),
          fence: 1,
          outcome: 'completed',
          ...SYSTEM_FIELDS,
        },
      ]) {
        // Sequential: each is a separate attempt with its own register row.
        // eslint-disable-next-line no-await-in-loop
        const result = await run(command as unknown as Command);
        expect(isCommandRefusal(result) ? result.code : '', command.command).toBe(
          'FIELD_NOT_WRITABLE',
        );
      }
    });

    it('preset.plan: the read half refuses the injection rather than ignoring it', async () => {
      const before = await countRows('field_defs');
      const result = await read({
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [{ key: 'spoofed', label: 'Spoofed', valueType: 'text', writeMode: 'generic' }],
        ...SYSTEM_FIELDS,
      } as unknown as ReadRequest);
      // This case used to assert `'plan' in result` — that the keys landed
      // nowhere — and passing on that was the defect: a read took no command
      // envelope, so `prepareCommand`'s rule never reached it and the injected
      // keys were dropped in silence with a `200` on top. D06 asks for a typed
      // refusal, and `reads/dispatch.ts` now applies the commands' own
      // `SYSTEM_OWNED_FIELDS` to a read payload.
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');
      expect(isCommandRefusal(result) ? [...result.names].toSorted() : []).toStrictEqual([
        'actor_id',
        'business_id',
        'created_at',
        'revision',
      ]);
      // Unchanged model state, which is the other half of the contract.
      expect(await countRows('field_defs')).toBe(before);

      // The positive control: the same plan without the injected keys still
      // plans, so the rule is not "refuse every preset".
      const control = await read({
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [{ key: 'spoofed', label: 'Spoofed', valueType: 'text', writeMode: 'generic' }],
      } as unknown as ReadRequest);
      expect('plan' in control).toBe(true);
      expect(await countRows('field_defs')).toBe(before);
    });
  });
});
