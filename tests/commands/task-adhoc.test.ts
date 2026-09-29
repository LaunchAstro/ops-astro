// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10a: the Ad hoc mark (CS-4.9).
//
// A task marked ad hoc drives billing and is the default for its new time
// entries. The mark is a task field owned by `task.set_adhoc` under
// `task:write`, audited as `task.adhoc changed`, reached by an agent only
// inside its delegation. The default a new time entry takes is read through
// `adHocDefault`, the one value the timer reads (owner question 36's
// recommendation: this part proves the default, MP-4-6 proves the entry).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { adHocDefault } from '../../packages/core-commands/src/reads/tasks.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-adhoc: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const CANARY = `canary-${randomUUID()}`;

const outcomeOf = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  let db: FreshDatabase;
  let alpha: BusinessId;
  let bravo: BusinessId;
  let writer: Member;
  let reader: Member;
  let clientAWriter: Member;
  let bravoWriter: Member;

  const as = async (business: BusinessId, member: Member, body: Record<string, unknown>) =>
    await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);

  const row = async (recordId: string) =>
    (
      await db.admin.execute<{ readonly revision: string; readonly ad_hoc: boolean | null }>(
        `select revision::text as revision, bool_2 as ad_hoc from public.records where id = $1`,
        [recordId],
      )
    )[0];

  const fresh = async (business: BusinessId, by: Member, title: string) => {
    const made = await as(business, by, { command: 'task.create', fields: { title } });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    const recordId = made.recordId ?? '';
    return { recordId, revision: Number((await row(recordId))?.revision) };
  };

  const setAdHoc = async (
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

  const defaultOf = async (business: BusinessId, recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const spine = await readTaskSpine(tx);
      return await adHocDefault(tx, spine.taskTypeId, recordId);
    });

  beforeAll(async () => {
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
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('is declared as a task write an agent reaches only inside its delegation', () => {
    const declared = COMMAND_SURFACE.find((each) => String(each.name) === 'task.set_adhoc');
    expect([
      declared?.kind,
      declared?.collection,
      declared?.action,
      declared?.authorisedOn,
      declared?.agent,
    ]).toStrictEqual(['write', 'task', 'write', 'record', 'delegated']);
  });

  it('marks the task ad hoc and back, each in its own slot, and the read shows it', async () => {
    const task = await fresh(alpha, writer, 'ad hoc work');
    expect(outcomeOf(await setAdHoc(alpha, writer, task, true))).toStrictEqual({ applied: true });
    expect((await row(task.recordId))?.ad_hoc).toBe(true);
    const read = await executeRead(db.app, alpha, writer.presented, {
      read: 'task.read',
      recordId: task.recordId,
    });
    expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.adHoc).toBe(true);
    const off = await setAdHoc(alpha, writer, { ...task, revision: task.revision + 1 }, false);
    expect(outcomeOf(off)).toStrictEqual({ applied: true });
    expect((await row(task.recordId))?.ad_hoc).toBe(false);
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
    ['an object', { on: true }],
  ])('refuses %s as the mark and writes nothing', async (_label, value) => {
    const task = await fresh(alpha, writer, 'hostile');
    const answer = await setAdHoc(alpha, writer, task, value);
    expect(outcomeOf(answer)).toMatchObject({ code: 'FIELD_VALUE_INVALID' });
    expect(Number((await row(task.recordId))?.revision)).toBe(task.revision);
  });

  it('owns the mark: task.update is refused and names the owning command', async () => {
    const task = await fresh(alpha, writer, 'generic');
    const answer = await as(alpha, writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ad_hoc: true },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['ad_hoc=task.set_adhoc'],
    });
  });

  describe('MP-4-10 audited changes: task.adhoc changed', () => {
    it('writes the change and the refusal to the audit chain as task.set_adhoc', async () => {
      const task = await fresh(alpha, writer, 'audited');
      const [applied, refusal] = [randomUUID(), randomUUID()];
      await setAdHoc(alpha, writer, task, true, applied);
      await setAdHoc(alpha, reader, { ...task, revision: task.revision + 1 }, false, refusal);
      const events = await db.admin.execute<{
        readonly actor_id: string;
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
      }>(
        `select actor_id, outcome, refusal_code, subject_record_id from public.audit_events
          where business_id = $1 and command = 'task.set_adhoc' and operation_id = any($2::text[])
          order by seq`,
        [alpha, [applied, refusal]],
      );
      // `toEqual`: the driver's rows are not plain objects.
      expect(events).toEqual([
        {
          actor_id: writer.actorId,
          outcome: 'applied',
          refusal_code: null,
          subject_record_id: task.recordId,
        },
        {
          actor_id: reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          subject_record_id: task.recordId,
        },
      ]);
      // The change and its record committed together: the mark is what the audit says.
      expect((await row(task.recordId))?.ad_hoc).toBe(true);
    });
  });

  describe('MP-4-10 ad hoc time default', () => {
    it('a new time entry on an ad hoc task defaults to ad hoc; otherwise it does not', async () => {
      const task = await fresh(alpha, writer, 'timed');
      expect(await defaultOf(alpha, task.recordId)).toBe(false);
      await setAdHoc(alpha, writer, task, true);
      expect(await defaultOf(alpha, task.recordId)).toBe(true);
      await setAdHoc(alpha, writer, { ...task, revision: task.revision + 1 }, false);
      expect(await defaultOf(alpha, task.recordId)).toBe(false);
    });

    it('never reads another business’s task: its mark is not this business’s default', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      await setAdHoc(bravo, bravoWriter, foreign, true);
      expect(await defaultOf(alpha, foreign.recordId)).toBe(false);
    });
  });

  describe('MP-4-10 permission refusals: task:write', () => {
    it('refuses a caller without task:write and writes nothing', async () => {
      const task = await fresh(alpha, writer, 'read only');
      const answer = await setAdHoc(alpha, reader, task, true);
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect((await row(task.recordId))?.ad_hoc).toBeNull();
      expect(JSON.stringify(answer)).not.toContain(task.recordId);
    });
  });

  describe('MP-4-10 isolation: ad hoc', () => {
    it('another business: its task is not found and keeps its mark', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      const answer = await setAdHoc(alpha, writer, foreign, true);
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect((await row(foreign.recordId))?.ad_hoc).toBeNull();
    });

    it('another client in the same business: a writer on client A’s task cannot mark client B’s', async () => {
      const taskA = await fresh(alpha, writer, 'client A');
      const taskB = await fresh(alpha, writer, CANARY);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
      });
      expect(outcomeOf(await setAdHoc(alpha, clientAWriter, taskA, true))).toStrictEqual({
        applied: true,
      });
      const refused = await setAdHoc(alpha, clientAWriter, taskB, true);
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect((await row(taskB.recordId))?.ad_hoc).toBeNull();
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-10 isolation: ad hoc under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('ha', `adhoc-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    const revision = async (recordId: string) =>
      Number(
        (
          await world.db.admin.execute<{ readonly revision: string }>(
            `select revision::text as revision from public.records where id = $1`,
            [recordId],
          )
        )[0]?.revision,
      );
    const markOf = async (recordId: string) =>
      (
        await world.db.admin.execute<{ readonly ad_hoc: boolean | null }>(
          `select bool_2 as ad_hoc from public.records where id = $1`,
          [recordId],
        )
      )[0]?.ad_hoc;

    it('an agent marks its own delegated task, and no other', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const own = await world.asAgent(
        {
          command: 'task.set_adhoc',
          operationId: randomUUID(),
          recordId: picked.taskId,
          expectedRevision: await revision(picked.taskId),
          fields: { ad_hoc: true },
        },
        picked.credential,
      );
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(await markOf(picked.taskId)).toBe(true);
      const foreign = await world.asAgent(
        {
          command: 'task.set_adhoc',
          operationId: randomUUID(),
          recordId: otherId,
          expectedRevision: await revision(otherId),
          fields: { ad_hoc: true },
        },
        picked.credential,
      );
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
      expect(await markOf(otherId)).toBeNull();
    });
  },
);
