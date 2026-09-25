// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB continuation (final review round 1, the lead's rulings on the
// first handback's proposals).
//
// 1. A direct `executeCommand` caller with a non-finite number still leaves
//    its `failed` event: the fallback no longer takes a digest that throws.
// 2. `registerAttempt` stores a result every writer hands it, so a refusal
//    name holding NUL or an unpaired surrogate cannot fault the register.
// 3. A field value the `data` jsonb cannot hold (NUL anywhere in a json
//    field, an unpaired surrogate in a text or json field) is refused
//    `FIELD_VALUE_INVALID` with its refused row, not raised on.
// 4. A deadlock victim (40P01) is retried once in a fresh transaction, as a
//    lost race is, rather than answered as an outage.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import {
  isCommandRefusal,
  refuseCommand,
} from '../../packages/core-records/src/commands/refusal.ts';
import { registerAttempt } from '../../packages/core-records/src/commands/register-store.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE = String.fromCodePoint(0xdc00);

describe.skipIf(serverUrl === undefined)('FR1-JSONB continuation', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let spine: InstalledTaskSpine;
  let blocker: postgres.Sql;

  const audit = async (operationId: string) =>
    await db.admin.execute<{ readonly outcome: string; readonly refusal_code: string | null }>(
      `select outcome, refusal_code from public.audit_events
        where business_id = $1 and operation_id = $2 order by seq`,
      [business, operationId],
    );

  const create = async (operationId: string, fields: Record<string, unknown>, extra = {}) =>
    await executeCommand(db.app, business, worker.presented, 'api', {
      command: 'task.create',
      operationId,
      fields,
      ...extra,
    } as never);

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr1_jsonb_cont' });
    business = await insertBusiness(db.app, 'jsonbcont');
    spine = await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'read');
    });
    // A json-typed field, as a preset's `create_unslotted_field` installs one.
    await db.admin.execute(
      `insert into public.field_defs
         (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
          visibility_class, searchable, unique_value, origin)
       values ($1, $2, $3, 'meta', 'Meta', 'json', null, 'generic', 'internal', false, false, 'preset')`,
      [business, randomUUID(), spine.taskTypeId],
    );
    const url = new URL(serverUrl as string);
    url.pathname = `/${db.name}`;
    blocker = postgres(url.toString(), { max: 2, onnotice: () => undefined });
  }, 60_000);

  afterAll(async () => {
    await blocker?.end();
    await db?.drop();
  });

  it('1: a non-finite number from a direct caller faults and still writes its failed event', async () => {
    const operationId = `op-inf-${randomUUID()}`;
    await expect(
      create(operationId, { title: 'x' }, { n: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow();
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and outcome = 'failed' and command = 'task.create'
          and operation_id = $2`,
      [business, operationId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('2: registerAttempt stores a refusal whose name holds NUL or an unpaired surrogate', async () => {
    const operationId = `op-reg-${randomUUID()}`;
    await db.app.withBusiness(business, async (tx) => {
      await registerAttempt(tx, {
        operationId,
        command: 'task.create',
        actorId: worker.actorId,
        digest: '0'.repeat(64),
        result: refuseCommand('FIELD_UNKNOWN', [`a${NUL}`, `b${LONE}`], []),
        recordId: null,
      });
    });
    const rows = await db.admin.execute<{ readonly result: { readonly names: string[] } }>(
      `select result from public.operations where business_id = $1 and operation_id = $2`,
      [business, operationId],
    );
    expect(rows[0]?.result.names).toStrictEqual(['a\\u0000', 'b\\udc00']);
  });

  for (const [label, fields] of [
    ['an unpaired surrogate in a text field', { title: `a${LONE}` }],
    ['NUL inside a json field', { title: 'x', meta: { note: `a${NUL}b` } }],
    ['an unpaired surrogate as a json key', { title: 'x', meta: { [`k${LONE}`]: 1 } }],
  ] as const) {
    it(`3: ${label} is refused FIELD_VALUE_INVALID with its refused row`, async () => {
      const operationId = `op-val-${randomUUID()}`;
      const outcome = await create(operationId, fields);
      expect(isCommandRefusal(outcome) && outcome.code).toBe('FIELD_VALUE_INVALID');
      expect(await audit(operationId)).toEqual([
        { outcome: 'refused', refusal_code: 'FIELD_VALUE_INVALID' },
      ]);
    });
  }

  it('3: a well-formed json value and a paired surrogate are still accepted', async () => {
    const outcome = await create(`op-ok-${randomUUID()}`, {
      title: 'emoji \u{1F600}',
      meta: { note: 'fine', list: [1, 'two'] },
    });
    expect(isCommandRefusal(outcome)).toBe(false);
  });

  it('4: a deadlock victim is retried once and the command applies', async () => {
    const made = await create(`op-dl-${randomUUID()}`, { title: 'deadlock target' });
    if (isCommandRefusal(made)) throw new Error(made.code);
    const operationId = `op-dl-${randomUUID()}`;

    let command: Promise<unknown> | undefined;
    await blocker.begin(async (sql) => {
      // The blocker must not be the one the detector picks, so it waits longest.
      await sql`set local deadlock_timeout = '30s'`;
      await sql`select id from public.records where id = ${made.recordId} for update`;
      command = executeCommand(db.app, business, worker.presented, 'api', {
        command: 'task.update',
        operationId,
        recordId: String(made.recordId),
        expectedRevision: Number(made.revision),
        fields: { title: 'after the deadlock' },
      });
      command.catch(() => undefined);
      // The command has read its grants and now waits on the row this holds.
      for (let attempt = 0; ; attempt += 1) {
        if (attempt > 400) throw new Error('the command never waited on the held row');
        // eslint-disable-next-line no-await-in-loop
        const waiting = await blocker`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`;
        if (Number(waiting[0]?.['n']) >= 1) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      // Now wait on the command: its grants read holds a lock this conflicts with.
      await sql`lock table public.grants in access exclusive mode`;
    });

    const outcome = await command;
    expect(
      isCommandRefusal(outcome as never) ? (outcome as { code: string }).code : 'applied',
    ).toBe('applied');
    expect(await audit(operationId)).toEqual([{ outcome: 'applied', refusal_code: null }]);
  }, 30_000);
});
