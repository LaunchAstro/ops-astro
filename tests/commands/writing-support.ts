// SPDX-License-Identifier: AGPL-3.0-only
//
// The seed the MP-4-7 suites share (`task-writing.test.ts`,
// `task-writing-agent.test.ts`): two businesses, a writer and a reader in
// the first, a writer holding one task by a record grant, and a writer in the
// second; each task written through `task.update` and read back by row.

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

export const outcomeOf = (
  answer: CommandResult,
): { code: string; names: readonly string[] } | { applied: true } =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

/** The read's brief, by name: the field the task detail carries for it. */
export const briefOf = (task: object): unknown =>
  (task as Readonly<Record<string, unknown>>)['agentBrief'];

export interface Held {
  readonly revision: string;
  readonly description: string | null;
  readonly agent_brief: string | null;
}

export interface Written {
  readonly recordId: string;
  readonly revision: number;
}

/** The two texts and the revision of one record, read past every policy. */
export async function heldIn(db: FreshDatabase, recordId: string): Promise<Held | undefined> {
  const rows = await db.admin.execute<Held>(
    `select revision::text as revision, data ->> 'description' as description,
            data ->> 'agent_brief' as agent_brief
       from public.records where id = $1`,
    [recordId],
  );
  return rows[0];
}

export interface WritingWorld {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly writer: Member;
  readonly reader: Member;
  readonly clientAWriter: Member;
  readonly bravoWriter: Member;
  held(recordId: string): Promise<Held | undefined>;
  fresh(business: BusinessId, by: Member, title: string, text?: object): Promise<Written>;
  write(
    business: BusinessId,
    by: Member,
    task: Written,
    fields: Record<string, unknown>,
    operationId?: string,
  ): Promise<CommandResult>;
  readAs(business: BusinessId, member: Member, recordId: string): ReturnType<typeof executeRead>;
}

async function seed(db: FreshDatabase) {
  const alpha = (await insertBusiness(db.app, 'writing-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'writing-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const writer = await enrol(db.app, alpha, 'writer');
  const reader = await enrol(db.app, alpha, 'reader');
  const clientAWriter = await enrol(db.app, alpha, 'client-a-writer');
  const bravoWriter = await enrol(db.app, bravo, 'bravo-writer');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, writer, 'write');
    await grantTo(tx, writer, 'read');
    await grantTo(tx, reader, 'read');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoWriter, 'write');
    await grantTo(tx, bravoWriter, 'read');
  });
  return { alpha, bravo, writer, reader, clientAWriter, bravoWriter };
}

export async function writingWorld(): Promise<WritingWorld> {
  const db = await createFreshDatabase({ part: 'w' });
  const people = await seed(db);
  const as = async (business: BusinessId, member: Member, body: Record<string, unknown>) =>
    await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  const held = async (recordId: string) => await heldIn(db, recordId);
  return {
    db,
    ...people,
    held,
    async fresh(business, by, title, text = {}) {
      const made = await as(business, by, { command: 'task.create', fields: { title, ...text } });
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      const recordId = made.recordId ?? '';
      return { recordId, revision: Number((await held(recordId))?.revision) };
    },
    async write(business, by, task, fields, operationId = randomUUID()) {
      return await as(business, by, {
        command: 'task.update',
        operationId,
        recordId: task.recordId,
        expectedRevision: task.revision,
        fields,
      });
    },
    async readAs(business, member, recordId) {
      return await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });
    },
  };
}
