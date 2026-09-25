// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-TRASH: trash, purge and cancel meeting the
// authority and runtime rows they used to walk past.
//
// #1 (R1-AUTHORITY-1). A record-scoped grant reaches one record
// (`authority/grants.ts`, the scope match; `ident-audit-cases.ts`'s rhea), so
// `task.trash` on a root she holds must not stamp a child she does not. Red at
// 6f13be8: the walk followed `parent` with no check and answered `trashed: 2`.
//
// #7/#8/#9 (R1-THERMO-7, R1-AUTHORITY-8, R1-RUNTIME-9), one defect. A trashed
// task that a proposal ever named is held by four non-cascading keys from the
// runtime tables (0010, 0013), and the runtime class is refused, never faulted
// on (`tasks/trash.ts`, the retention register). Red at 6f13be8: the purge
// raised 23503 and every later purge in the business raised again.
//
// #10 (R1-RUNTIME-10). Cancellation is the control that releases a lineage's
// holds (RUNTIME.md, "Cancellation"), so it has to reach a trashed task's
// lineage. Red at 6f13be8: `task.cancel` answered NOT_FOUND and the hold stayed.
//
// Every row is synthetic and lives in a throwaway database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1 trash: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

function applied(result: CommandResult, what: string) {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return result;
}

describe.skipIf(serverUrl === undefined)('final review round 1: trash, purge and cancel', () => {
  let db: FreshDatabase;
  let business: BusinessId;
  let ada: Member;
  let rhea: Member;

  const run = async (who: Member, body: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, business, who.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as Request);

  const create = async (title: string, extra: Readonly<Record<string, unknown>> = {}) => {
    const made = applied(
      await run(ada, { command: 'task.create', fields: { title }, ...extra }),
      'create',
    );
    return { id: made.recordId ?? '', revision: made.revision ?? 0 };
  };

  const revisionOf = async (id: string) =>
    Number(
      (
        await db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from records where business_id = $1 and id = $2`,
          [business, id],
        )
      )[0]?.revision,
    );

  const trashedIds = async (ids: readonly string[]) =>
    new Set(
      (
        await db.admin.execute<{ readonly id: string }>(
          `select id::text as id from records
            where business_id = $1 and id = any ($2::uuid[]) and deleted_at is not null`,
          [business, ids],
        )
      ).map((row) => row.id),
    );

  const presentIds = async (ids: readonly string[]) =>
    new Set(
      (
        await db.admin.execute<{ readonly id: string }>(
          `select id::text as id from records where business_id = $1 and id = any ($2::uuid[])`,
          [business, ids],
        )
      ).map((row) => row.id),
    );

  const count = async (sql: string, params: readonly unknown[]) =>
    Number((await db.admin.execute<{ readonly n: string }>(sql, params))[0]?.n ?? '0');

  const auditOf = async (operationId: string) =>
    (await db.app.withBusiness(business, readAuditEvents)).filter(
      (event) => event.operation_id === operationId,
    );

  /** Propose on a task and approve the exact version: a held reservation on its envelope. */
  const approvedOn = async (taskId: string) => {
    const proposed = applied(
      await run(ada, {
        command: 'task.propose',
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        purpose: 'draft_the_reply',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      }),
      'propose',
    ).detail as Record<string, string>;
    const decided = applied(
      await run(ada, {
        command: 'task.decide',
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'go ahead',
      }),
      'decide',
    ).detail as Record<string, unknown>;
    return {
      lineageId: proposed['lineageId'] ?? '',
      reservationId: String(decided['reservationId']),
    };
  };

  const trash = async (who: Member, taskId: string) =>
    await run(who, {
      command: 'task.trash',
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
    });

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/final-r1-trash@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'fr1trash' });
    business = (await insertBusiness(db.app, 'final-r1-trash')) as BusinessId;
    await installSpine(db.app, business);
    ada = await enrol(db.app, business, 'ada');
    rhea = await enrol(db.app, business, 'rhea');
    await db.app.withBusiness(business, async (tx) => {
      await installBusinessSettings(tx);
      await writeBusinessSetting(tx, { key: 'retention_window_days', value: 0 });
      for (const action of ['read', 'write', 'decide', 'assign', 'comment', 'manage'] as const) {
        // Sequential: `issueGrant` reads the granter's own rows.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, ada, action);
      }
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 100000, 'AUD')`,
        [business, randomUUID()],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** Rhea's reach: read and write on exactly these records, as ident-audit-cases.ts gives her. */
  const reach = async (ids: readonly string[]) => {
    await db.app.withBusiness(business, async (tx) => {
      for (const id of ids) {
        for (const action of ['read', 'write'] as const) {
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, rhea, action, { kind: 'record', id });
        }
      }
    });
  };

  describe('#1 task.trash stays inside the caller’s grant', () => {
    it('refuses the whole subtree when a live descendant is outside a record-scoped grant', async () => {
      const root = await create('rhea’s task');
      const child = await create('ada’s child under it', { parentId: root.id });
      await reach([root.id]);

      const operationId = randomUUID();
      const answer = await run(rhea, {
        command: 'task.trash',
        operationId,
        recordId: root.id,
        expectedRevision: await revisionOf(root.id),
      });
      if (!isCommandRefusal(answer))
        throw new Error(`trash applied: ${JSON.stringify(answer.detail)}`);
      expect(answer.code).toBe('SCOPE_NOT_GRANTED');
      // No count and no identifier: the refusal says nothing about what lies below.
      expect(answer.names).toStrictEqual([]);
      expect(JSON.stringify(answer)).not.toContain(child.id);
      expect(await trashedIds([root.id, child.id])).toStrictEqual(new Set());
      expect((await auditOf(operationId)).map((event) => event.outcome)).toStrictEqual(['refused']);

      // A business-scoped writer trashes the same subtree whole.
      const whole = applied(await trash(ada, root.id), 'ada trash');
      expect(whole.detail['trashed']).toBe(2);
      expect(await trashedIds([root.id, child.id])).toStrictEqual(new Set([root.id, child.id]));
    });

    it('trashes a subtree whose every record the grant names, and a childless task of her own', async () => {
      const root = await create('a root rhea holds');
      const child = await create('a child rhea also holds', { parentId: root.id });
      const alone = await create('a childless task of rhea’s');
      await reach([root.id, child.id, alone.id]);

      const both = applied(await trash(rhea, root.id), 'rhea subtree trash');
      expect(both.detail['trashed']).toBe(2);
      const single = applied(await trash(rhea, alone.id), 'rhea single trash');
      expect(single.detail['trashed']).toBe(1);
      expect(await trashedIds([root.id, child.id, alone.id])).toStrictEqual(
        new Set([root.id, child.id, alone.id]),
      );
    });
  });

  describe('#7 #8 #9 task.purge keeps a task the runtime rows hold, and purges the rest', () => {
    it('purges the plain task, keeps the proposed one with its lineage and hold, and runs again', async () => {
      const proposed = await create('a proposed and approved task');
      const plain = await create('a plain task');
      const { lineageId, reservationId } = await approvedOn(proposed.id);
      const heldBefore = await count(
        `select held_minor::text as n from public.task_envelopes where business_id = $1 and task_id = $2`,
        [business, proposed.id],
      );
      expect(heldBefore).toBe(2_500);
      applied(await trash(ada, proposed.id), 'trash proposed');
      applied(await trash(ada, plain.id), 'trash plain');

      const operationId = randomUUID();
      const purged = applied(await run(ada, { command: 'task.purge', operationId }), 'purge');
      expect(purged.detail['purged']).toBeGreaterThanOrEqual(1);
      expect(purged.detail['retained']).toContain(proposed.id);
      expect(await presentIds([proposed.id, plain.id])).toStrictEqual(new Set([proposed.id]));
      expect(
        await count(
          `select count(*)::text as n from public.proposal_lineages where business_id = $1 and id = $2`,
          [business, lineageId],
        ),
      ).toBe(1);
      expect(
        await count(
          `select held_minor::text as n from public.task_envelopes where business_id = $1 and task_id = $2`,
          [business, proposed.id],
        ),
      ).toBe(heldBefore);
      expect(
        await count(
          `select count(*)::text as n from public.reservations where business_id = $1 and id = $2 and state = 'held'`,
          [business, reservationId],
        ),
      ).toBe(1);
      expect((await auditOf(operationId)).map((event) => event.outcome)).toStrictEqual(['applied']);

      // The retained task does not block the next purge.
      const later = await create('trashed after the first purge');
      applied(await trash(ada, later.id), 'trash later');
      const again = applied(await run(ada, { command: 'task.purge' }), 'second purge');
      expect(again.detail['purged']).toBe(1);
      expect(again.detail['retained']).toStrictEqual([proposed.id]);
      expect(await presentIds([proposed.id, later.id])).toStrictEqual(new Set([proposed.id]));
    });
  });

  describe('#10 a trashed task’s approved hold is releasable', () => {
    it('lets task.cancel reach the trashed task’s lineage and release its hold', async () => {
      const task = await create('approved, then trashed');
      const { lineageId, reservationId } = await approvedOn(task.id);
      applied(await trash(ada, task.id), 'trash');

      const cancelled = applied(
        await run(ada, { command: 'task.cancel', recordId: task.id, lineageId, reason: 'trashed' }),
        'cancel',
      );
      expect(cancelled.detail['state']).toBe('cancelled');
      expect(
        await count(
          `select count(*)::text as n from public.reservations
            where business_id = $1 and id = $2 and state = 'abandoned' and classified_cause = 'lineage_cancelled'`,
          [business, reservationId],
        ),
      ).toBe(1);
      expect(
        await count(
          `select held_minor::text as n from public.task_envelopes where business_id = $1 and task_id = $2`,
          [business, task.id],
        ),
      ).toBe(0);
    });

    it('still answers task.restart on a trashed task NOT_FOUND', async () => {
      const task = await create('proposed, then trashed');
      const { lineageId } = await approvedOn(task.id);
      applied(await trash(ada, task.id), 'trash');
      applied(
        await run(ada, { command: 'task.cancel', recordId: task.id, lineageId, reason: 'stop' }),
        'cancel',
      );
      const restarted = await run(ada, { command: 'task.restart', recordId: task.id, lineageId });
      expect(isCommandRefusal(restarted) ? restarted.code : 'applied').toBe('NOT_FOUND');
      // The read side still treats it as gone.
      await expect(
        executeRead(db.app, business, ada.presented, { read: 'task.read', recordId: task.id }),
      ).resolves.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
