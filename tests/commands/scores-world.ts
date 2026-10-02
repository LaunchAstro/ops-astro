// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 marks command” cases: the database, the
// people and the helpers they read, set up once per test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { insertBusiness } from '../identity/fixture.ts';

import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

import { enrol, grantTo, installSpine, type Member } from './fixture.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { RefusalCode } from '../../packages/core-records/src/register.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Request = Parameters<typeof executeCommand>[4];

export const outcomeOf: (answer: CommandResult) =>
  | {
      code: RefusalCode;
      names: readonly string[];
      applied?: never;
    }
  | { code?: never; names?: never; applied: boolean } = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

export let db: FreshDatabase;

export let business: string;

export let writer: Member;

export let reader: Member;

export const as: (
  member: Member,
  command: Readonly<Record<string, unknown>>,
) => Promise<CommandResult> = async (member: Member, command: Readonly<Record<string, unknown>>) =>
  await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...command,
  } as unknown as Request);

export const taskRow: (
  recordId: string,
  where?: string,
) => Promise<
  | {
      readonly revision: string;
      readonly impact: string | null;
      readonly confidence: string | null;
      readonly ease: string | null;
    }
  | undefined
> = async (recordId: string, where = business) =>
  (
    await db.admin.execute<{
      readonly revision: string;
      readonly impact: string | null;
      readonly confidence: string | null;
      readonly ease: string | null;
    }>(
      `select revision::text as revision, num_3::text as impact, num_4::text as confidence,
              num_5::text as ease
         from public.records where business_id = $1 and id = $2`,
      [where, recordId],
    )
  )[0];

export const freshTask: (
  title: string,
  by?: Member,
) => Promise<{ recordId: string; revision: number }> = async (
  title: string,
  by: Member = writer,
) => {
  const made = await as(by, { command: 'task.create', fields: { title } });
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const recordId = made.recordId ?? '';
  return { recordId, revision: Number((await taskRow(recordId))?.revision) };
};

// Data separation (owner rule): one crossing per boundary, each aimed at a
// real task whose title is a canary that no answer may carry, and each
// leaving the foreign task's marks and revision exactly as they were.
export const untouched: (
  recordId: string,
  revision: number,
  where?: string,
) => Promise<void> = async (recordId: string, revision: number, where = business) => {
  const row = await taskRow(recordId, where);
  expect([row?.revision, row?.impact, row?.confidence, row?.ease]).toStrictEqual([
    String(revision),
    null,
    null,
    null,
  ]);
};

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 's' });
  business = await insertBusiness(db.app, 'task-scores');
  await installSpine(db.app, business);
  writer = await enrol(db.app, business, 'writer');
  reader = await enrol(db.app, business, 'reader');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, writer, 'write');
    // Only so the client crossing can share one task with each client.
    await grantTo(tx, writer, 'share');
    await grantTo(tx, reader, 'read');
  });
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
