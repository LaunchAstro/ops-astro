// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-10 CS-4.9 ad hoc” cases: the database, the
// people and the helpers they read, set up once per test file that imports it.
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

import { adHocDefault } from '../../packages/core-commands/src/reads/tasks.ts';

import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';

import type { BusinessId } from '../../packages/core-records/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const CANARY: string = `canary-${randomUUID()}`;

export const outcomeOf: (answer: CommandResult) => Readonly<Record<string, unknown>> = (
  answer: CommandResult,
) => (isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true });

export let db: FreshDatabase;

export let alpha: BusinessId;

export let bravo: BusinessId;

export let writer: Member;

export let reader: Member;

export let clientAWriter: Member;

export let bravoWriter: Member;

export const as: (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
) => Promise<CommandResult> = async (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
) =>
  await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

export const row: (
  recordId: string,
) => Promise<{ readonly revision: string; readonly ad_hoc: boolean | null } | undefined> = async (
  recordId: string,
) =>
  (
    await db.admin.execute<{ readonly revision: string; readonly ad_hoc: boolean | null }>(
      `select revision::text as revision, bool_2 as ad_hoc from public.records where id = $1`,
      [recordId],
    )
  )[0];

export const fresh: (
  business: BusinessId,
  by: Member,
  title: string,
) => Promise<{ recordId: string; revision: number }> = async (
  business: BusinessId,
  by: Member,
  title: string,
) => {
  const made = await as(business, by, { command: 'task.create', fields: { title } });
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const recordId = made.recordId ?? '';
  return { recordId, revision: Number((await row(recordId))?.revision) };
};

export const setAdHoc: (
  business: BusinessId,
  by: Member,
  task: { recordId: string; revision: number },
  adHoc: unknown,
  operationId?: string,
) => Promise<CommandResult> = async (
  business: BusinessId,
  by: Member,
  task: { recordId: string; revision: number },
  adHoc: unknown,
  operationId: string = randomUUID(),
) =>
  await as(business, by, {
    command: 'task.set_adhoc',
    operationId,
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { ad_hoc: adHoc },
  });

export const defaultOf: (business: BusinessId, recordId: string) => Promise<boolean> = async (
  business: BusinessId,
  recordId: string,
) =>
  await db.app.withBusiness(business, async (tx) => {
    const spine = await readTaskSpine(tx);
    return await adHocDefault(tx, spine.taskTypeId, recordId);
  });

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 'h' });
  alpha = (await insertBusiness(db.app, 'adhoc-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'adhoc-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  writer = await enrol(db.app, alpha, 'writer');
  reader = await enrol(db.app, alpha, 'reader');
  clientAWriter = await enrol(db.app, alpha, 'client-a-writer');
  bravoWriter = await enrol(db.app, bravo, 'bravo-writer');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, writer, 'write');
    await grantTo(tx, writer, 'read');
    await grantTo(tx, reader, 'read');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoWriter, 'write');
  });
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
