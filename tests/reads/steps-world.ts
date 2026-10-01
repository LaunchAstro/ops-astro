// SPDX-License-Identifier: AGPL-3.0-only
//
// The seeded world MP-4-4's two suites read (`tests/reads/task-steps.test.ts`
// and `tests/commands/task-subtasks.test.ts`): two businesses, a parent under
// client A with two subtasks, another client's task and another business's
// task each planted under the parent behind every command's back, and a
// record-scoped reader holding the parent and its first subtask. Each suite
// seeds its own database from here.

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId, CommandRefusal } from '../../packages/core-records/src/index.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import type { ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import type { StepView } from '../../packages/core-wire/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Body = Readonly<Record<string, unknown>>;

export const CANARY: string = `canary-${randomUUID()}`;
export const CLIENT_A: string = randomUUID();
export const CLIENT_B: string = randomUUID();

export let db: FreshDatabase | undefined;
export let alpha: BusinessId;
export let bravo: BusinessId;
export let owner: Member;
export let bravoOwner: Member;
export let pairReader: Member;
export let reader: Member;
export const ids: Record<string, string> = {};

export const seeded = (): FreshDatabase => {
  if (db === undefined) throw new Error('the steps database was not seeded');
  return db;
};

export const send = async (
  business: BusinessId,
  member: Member,
  body: Body,
): Promise<CommandResult> =>
  await executeCommand(seeded().app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

export const command = async (
  business: BusinessId,
  member: Member,
  body: Body,
): Promise<CommandHandle> => {
  const answer = await send(business, member, body);
  if (isCommandRefusal(answer)) {
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  }
  return answer;
};

export const revisionOf = async (recordId: string): Promise<number> => {
  const rows = await seeded().admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

export const clientOf = async (recordId: string): Promise<string | null> => {
  const rows = await seeded().admin.execute<{ readonly client: string | null }>(
    `select uuid_7::text as client from public.records where id = $1`,
    [recordId],
  );
  return rows[0]?.client ?? null;
};

export const make = async (
  business: BusinessId,
  by: Member,
  name: string,
  title: string,
  placed: { readonly parentId?: string; readonly client?: string } = {},
): Promise<string> => {
  const made = await command(business, by, {
    command: 'task.create',
    fields: { title },
    ...(placed.parentId === undefined ? {} : { parentId: placed.parentId }),
  });
  const recordId = made.recordId ?? '';
  if (placed.client !== undefined) {
    await command(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { client: placed.client },
    });
  }
  ids[name] = recordId;
  return recordId;
};

export const read = async (
  business: BusinessId,
  member: Member,
  recordId: string,
): Promise<ReadResult | CommandRefusal> =>
  await executeRead(seeded().app, business, member.presented, { read: 'task.read', recordId });

export const stepsOf = async (
  business: BusinessId,
  member: Member,
  recordId: string,
): Promise<{ readonly steps: readonly StepView[]; readonly body: string }> => {
  const answer = await read(business, member, recordId);
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  return { steps: answer.task.steps, body: JSON.stringify(answer) };
};

export const titles = (steps: readonly StepView[]): readonly (string | null)[] =>
  steps.map((step) => step.title);

export async function seed(): Promise<void> {
  db = await createFreshDatabase({ part: 'st' });
  const d = db;
  alpha = (await insertBusiness(d.app, 'steps-alpha')) as BusinessId;
  bravo = (await insertBusiness(d.app, 'steps-bravo')) as BusinessId;
  await installSpine(d.app, alpha);
  await installSpine(d.app, bravo);
  owner = await enrol(d.app, alpha, 'owner');
  bravoOwner = await enrol(d.app, bravo, 'bravo-owner');
  pairReader = await enrol(d.app, alpha, 'pair-reader');
  reader = await enrol(d.app, alpha, 'reader');
  await d.app.withBusiness(alpha, async (tx) => {
    // `share` only so a task can be put under its client (`task.set_party`).
    for (const action of ['read', 'write', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
    await grantTo(tx, reader, 'read');
  });
  await d.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, bravoOwner, action);
    }
  });
  const parent = await make(alpha, owner, 'parent', 'Launch the site', { client: CLIENT_A });
  await make(alpha, owner, 'first', 'Write the copy', { parentId: parent });
  await make(alpha, owner, 'second', 'Check the forms', { parentId: parent });
  await make(alpha, owner, 'otherParent', 'Another client’s work', { client: CLIENT_B });
  await plant(d, parent);
}

/** The strays and the pair reader's grants, planted behind every command's back. */
async function plant(d: FreshDatabase, parent: string): Promise<void> {
  // Another client's task, made to point at the parent behind every
  // command's back, so only the read's grant filter stands between it and a
  // record-scoped reader of the parent.
  const stray = await make(alpha, owner, 'stray', CANARY, { client: CLIENT_B });
  await d.admin.execute(
    `update public.records set data = jsonb_set(data, '{parent}', to_jsonb($2::text))
      where id = $1`,
    [stray, parent],
  );
  // Another business's task pointing at the parent: forced RLS and the
  // business filter are all that keep it out.
  const foreign = await make(bravo, bravoOwner, 'foreign', CANARY);
  await d.admin.execute(
    `update public.records set data = jsonb_set(data, '{parent}', to_jsonb($2::text))
      where id = $1`,
    [foreign, parent],
  );
  await d.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, pairReader, 'read', { kind: 'record', id: parent });
    await grantTo(tx, pairReader, 'read', { kind: 'record', id: ids['first'] ?? '' });
  });
}

export async function dropSteps(): Promise<void> {
  await db?.drop();
}
