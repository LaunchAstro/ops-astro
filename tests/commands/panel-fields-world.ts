// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-8” field-edit cases: the database, the people
// and the helpers they read, set up once per test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { insertBusiness } from '../identity/fixture.ts';

import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

import { enrol, grantTo, installSpine, type Member } from './fixture.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';

import type { BusinessId } from '../../packages/core-records/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const CANARY: string = `canary-${randomUUID()}`;

export const outcomeOf: (
  answer: CommandResult | Awaited<ReturnType<typeof executeRead>>,
) => Readonly<Record<string, unknown>> = (answer) =>
  isCommandRefusal(answer) ? { code: answer.code } : { applied: true };

export let db: FreshDatabase;

export let alpha: BusinessId;

export let bravo: BusinessId;

/** Read, write and assign on every task here, and share to set a client. */
export let editor: Member;

/** Read only. */
export let reader: Member;

/** Read and write, never assign. */
export let writerNoAssign: Member;

/**
 * Read and write on one of client A's tasks only, granted by the case: main
 * resolves a command's grant at business or record scope, never party.
 */
export let clientAEditor: Member;

export let bravoEditor: Member;

export const clientA: string = randomUUID();

export const clientB: string = randomUUID();

export const as: (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
) => Promise<CommandResult> = async (business, member, body) =>
  await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

/** The stored row: its revision, title (txt_4), assignee (uuid_2) and due (ts_1). */
export interface TaskRow {
  readonly revision: number;
  readonly title: string | null;
  readonly assignee: string | null;
  readonly due: string | null;
}

export const rowOf = async (recordId: string): Promise<TaskRow | undefined> =>
  (
    await db.admin.execute<TaskRow>(
      `select revision::int as revision, txt_4 as title, uuid_2::text as assignee,
              to_char(ts_1 at time zone 'UTC', 'YYYY-MM-DD') as due
         from public.records where id = $1`,
      [recordId],
    )
  )[0];

/** A task by the business's editor, on a client when one is named. */
export const fresh = async (
  business: BusinessId,
  by: Member,
  title: string,
  client: string | null = null,
): Promise<string> => {
  const made = await as(business, by, { command: 'task.create', fields: { title } });
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const recordId = made.recordId ?? '';
  if (client !== null) {
    const set = await as(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: (await rowOf(recordId))?.revision,
      fields: { client },
    });
    if (isCommandRefusal(set)) throw new Error(`set_party refused ${set.code}`);
  }
  return recordId;
};

/** One panel edit: the command, the task and its fields, at the task's current revision. */
export const edit = async (
  business: BusinessId,
  by: Member,
  command: 'task.update' | 'task.assign',
  recordId: string,
  fields: Readonly<Record<string, unknown>>,
  operationId: string = randomUUID(),
): Promise<CommandResult> =>
  await as(business, by, {
    command,
    operationId,
    recordId,
    expectedRevision: (await rowOf(recordId))?.revision,
    fields,
  });

export const readAs = async (
  business: BusinessId,
  member: Member,
  recordId: string,
): ReturnType<typeof executeRead> =>
  await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

/** One audit event as the readback case reads it. */
export interface AuditRow {
  readonly command: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly refusal_code: string | null;
  readonly subject_record_id: string | null;
}

export const auditOf = async (operationIds: readonly string[]): Promise<readonly AuditRow[]> =>
  await db.admin.execute<AuditRow>(
    `select command, actor_id, outcome, refusal_code, subject_record_id from public.audit_events
      where business_id = $1 and operation_id = any($2::text[])
      order by seq`,
    [alpha, operationIds],
  );

export const auditCount = async (): Promise<number> =>
  Number(
    (
      await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.audit_events where business_id = $1`,
        [alpha],
      )
    )[0]?.n,
  );

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 'hp' });
  alpha = (await insertBusiness(db.app, 'panel-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'panel-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  editor = await enrol(db.app, alpha, 'editor');
  reader = await enrol(db.app, alpha, 'reader');
  writerNoAssign = await enrol(db.app, alpha, 'writer-no-assign');
  clientAEditor = await enrol(db.app, alpha, 'client-a-editor');
  bravoEditor = await enrol(db.app, bravo, 'bravo-editor');
  await db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['read', 'write', 'assign', 'share'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, editor, action);
    }
    await grantTo(tx, reader, 'read');
    await grantTo(tx, writerNoAssign, 'read');
    await grantTo(tx, writerNoAssign, 'write');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write', 'assign'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, bravoEditor, action);
    }
  });
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
