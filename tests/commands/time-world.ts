// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the MP-4-6 command suites run in: two businesses, and in the first
// two timing members (Ada and Noah), a task reader and writer who holds no
// `time:write`, and a timing member who reads nothing yet (the client-A
// reader, given one task's read grant by the test that needs it).

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { TaskTimeView } from '../../packages/core-wire/src/index.ts';

export const CANARY: string = `canary-${randomUUID()}`;
export const WHOLE: { readonly kind: 'business'; readonly id: null } = {
  kind: 'business',
  id: null,
};

export const outcomeOf = (
  answer: CommandResult,
): { readonly code: string; readonly names: readonly string[] } | { readonly applied: true } =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

export const entryIdOf = (answer: CommandResult): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as { entryId?: unknown }).entryId);
};

type Body = Record<string, unknown>;

export interface EntryRow {
  readonly id: string;
  readonly person_id: string;
  readonly minutes: number | null;
  readonly note: string;
  readonly deleted: boolean;
}

export interface TimeWorld {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly ada: Member;
  readonly noah: Member;
  readonly taskOnly: Member;
  readonly clientA: Member;
  readonly bravoOwner: Member;
  as(business: BusinessId, member: Member, body: Body): Promise<CommandResult>;
  fresh(business: BusinessId, by: Member, title: string): Promise<string>;
  timeOf(
    business: BusinessId,
    member: Member,
    taskId: string,
  ): Promise<{ readonly time: TaskTimeView | null; readonly body: string }>;
  entries(taskId: string): Promise<readonly EntryRow[]>;
  backdate(member: Member, seconds: number): Promise<void>;
}

async function grantTiming(db: FreshDatabase, business: BusinessId, members: Member[]) {
  await db.app.withBusiness(business, async (tx) => {
    for (const member of members) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'read');
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'write');
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'write', WHOLE, false, 'time');
    }
  });
}

async function cast(db: FreshDatabase) {
  const alpha = (await insertBusiness(db.app, 'time-cmd-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'time-cmd-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const people = {
    ada: await enrol(db.app, alpha, 'ada'),
    noah: await enrol(db.app, alpha, 'noah'),
    taskOnly: await enrol(db.app, alpha, 'task-only'),
    clientA: await enrol(db.app, alpha, 'client-a'),
    bravoOwner: await enrol(db.app, bravo, 'bravo-owner'),
  };
  await grantTiming(db, alpha, [people.ada, people.noah]);
  await grantTiming(db, bravo, [people.bravoOwner]);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, people.taskOnly, 'read');
    await grantTo(tx, people.taskOnly, 'write');
    await grantTo(tx, people.clientA, 'write', WHOLE, false, 'time');
  });
  return { alpha, bravo, ...people };
}

export async function timeWorld(part: string): Promise<TimeWorld> {
  const db = await createFreshDatabase({ part });
  const world = await cast(db);
  const as = async (business: BusinessId, member: Member, body: Body) =>
    await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  return {
    db,
    ...world,
    as,
    async fresh(business, by, title) {
      const made = await as(business, by, { command: 'task.create', fields: { title } });
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      return made.recordId ?? '';
    },
    async timeOf(business, member, taskId) {
      const read = await executeRead(db.app, business, member.presented, {
        read: 'task.read',
        recordId: taskId,
      });
      if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
      return { time: read.task.time, body: JSON.stringify(read) };
    },
    async entries(taskId) {
      return await db.admin.execute<EntryRow>(
        `select id, person_id, minutes, note, deleted_at is not null as deleted
           from public.time_entries where task_id = $1 order by started_at, id`,
        [taskId],
      );
    },
    async backdate(member, seconds) {
      await db.admin.execute(
        `update public.time_entries set started_at = now() - make_interval(secs => $2)
          where person_id = $1 and ended_at is null`,
        [member.personId, seconds],
      );
    },
  };
}
