// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-7: the description and the agent brief (CS-4.23, CS-4.24).
//
// Both are ordinary task text, written through `task.update` under
// `task:write` and audited as that command with the field named in its
// `changed` list: `task.description changed` and `task.agent brief changed`
// are its two tracked actions. The brief is a task field of its own
// (`agent_brief`, migration 0035), unslotted like the description, internal
// like it: a client's shared view carries neither. An agent writes the two
// on its own delegated task and nothing else through `task.update`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-writing: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const CANARY = `canary-${randomUUID()}`;

const outcomeOf = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

/** The read's brief, by name: the field the task detail carries for it. */
const briefOf = (task: object): unknown =>
  (task as Readonly<Record<string, unknown>>)['agentBrief'];

interface Held {
  readonly revision: string;
  readonly description: string | null;
  readonly agent_brief: string | null;
}

describe.skipIf(serverUrl === undefined)('MP-4-7 description and agent brief', () => {
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

  const held = async (recordId: string): Promise<Held | undefined> =>
    (
      await db.admin.execute<Held>(
        `select revision::text as revision, data ->> 'description' as description,
                data ->> 'agent_brief' as agent_brief
           from public.records where id = $1`,
        [recordId],
      )
    )[0];

  const fresh = async (business: BusinessId, by: Member, title: string, text = {}) => {
    const made = await as(business, by, { command: 'task.create', fields: { title, ...text } });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    const recordId = made.recordId ?? '';
    return { recordId, revision: Number((await held(recordId))?.revision) };
  };

  const write = async (
    business: BusinessId,
    by: Member,
    task: { recordId: string; revision: number },
    fields: Record<string, unknown>,
    operationId: string = randomUUID(),
  ) =>
    await as(business, by, {
      command: 'task.update',
      operationId,
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields,
    });

  const readAs = async (business: BusinessId, member: Member, recordId: string) =>
    await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'w' });
    alpha = (await insertBusiness(db.app, 'writing-alpha')) as BusinessId;
    bravo = (await insertBusiness(db.app, 'writing-bravo')) as BusinessId;
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
      await grantTo(tx, bravoWriter, 'read');
    });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('the brief is a task field of its own: text, unslotted, generic, internal, core', async () => {
    const rows = await db.admin.execute<Record<string, unknown>>(
      `select f.key, f.value_type, f.slot, f.write_mode, f.owning_operation, f.visibility_class, f.origin
         from public.field_defs f
         join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
        where f.business_id = $1 and t.key = 'task' and f.key in ('agent_brief', 'description')
        order by f.key`,
      [alpha],
    );
    const text = { value_type: 'text', slot: null, write_mode: 'generic', owning_operation: null };
    expect(rows).toEqual([
      { key: 'agent_brief', ...text, visibility_class: 'internal', origin: 'core' },
      { key: 'description', ...text, visibility_class: 'internal', origin: 'core' },
    ]);
  });

  it('task.update is a task write an agent reaches only inside its delegation', () => {
    const declared = COMMAND_SURFACE.find((each) => String(each.name) === 'task.update');
    expect([declared?.collection, declared?.action, declared?.agent]).toStrictEqual([
      'task',
      'write',
      'delegated',
    ]);
  });

  describe('MP-4-7 CS-4.24 write the description', () => {
    it('saves the description, and the read gives it back', async () => {
      const task = await fresh(alpha, writer, 'described');
      const answer = await write(alpha, writer, task, { description: 'Fix the pacing.' });
      expect(outcomeOf(answer)).toStrictEqual({ applied: true });
      expect((await held(task.recordId))?.description).toBe('Fix the pacing.');
      const read = await readAs(alpha, writer, task.recordId);
      expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.description).toBe(
        'Fix the pacing.',
      );
    });

    it('clears it with null', async () => {
      const task = await fresh(alpha, writer, 'cleared', { description: 'was here' });
      expect(outcomeOf(await write(alpha, writer, task, { description: null }))).toStrictEqual({
        applied: true,
      });
      expect((await held(task.recordId))?.description).toBeNull();
    });
  });

  describe('MP-4-7 CS-4.23 write the agent brief', () => {
    it('saves the brief whole, markdown and all, and the read gives it back', async () => {
      const brief = '# Brief\n**Objective:** hold the spend.\n\n- one\n- two\n';
      const task = await fresh(alpha, writer, 'briefed');
      const answer = await write(alpha, writer, task, { agent_brief: brief });
      expect(outcomeOf(answer)).toStrictEqual({ applied: true });
      expect((await held(task.recordId))?.agent_brief).toBe(brief);
      const read = await readAs(alpha, writer, task.recordId);
      expect(isCommandRefusal(read) || !('task' in read) ? null : briefOf(read.task)).toBe(brief);
    });

    it('reads null where none has been written', async () => {
      const task = await fresh(alpha, writer, 'unbriefed');
      const read = await readAs(alpha, writer, task.recordId);
      expect(
        isCommandRefusal(read) || !('task' in read) ? undefined : briefOf(read.task),
      ).toBeNull();
    });

    it.each([
      ['a number', 7],
      ['an object', { text: 'x' }],
      ['a list', ['x']],
    ])('refuses %s as the brief and writes nothing', async (_label, value) => {
      const task = await fresh(alpha, writer, 'hostile');
      const answer = await write(alpha, writer, task, { agent_brief: value });
      expect(outcomeOf(answer)).toMatchObject({ code: 'FIELD_VALUE_INVALID' });
      expect(Number((await held(task.recordId))?.revision)).toBe(task.revision);
    });
  });

  describe('MP-4-7 audit read-back: task.description changed, task.agent brief changed', () => {
    // The audit row names the command; the field it changed is in the result
    // the register stored in the same transaction, found by the operation.
    it('each change and its refusal join the audit chain as task.update, the field named', async () => {
      const task = await fresh(alpha, writer, 'audited');
      const [description, brief, refusal] = [randomUUID(), randomUUID(), randomUUID()];
      await write(alpha, writer, task, { description: 'd' }, description);
      await write(
        alpha,
        writer,
        { ...task, revision: task.revision + 1 },
        { agent_brief: 'b' },
        brief,
      );
      await write(
        alpha,
        reader,
        { ...task, revision: task.revision + 2 },
        { agent_brief: 'x' },
        refusal,
      );
      const events = await db.admin.execute<{
        readonly operation_id: string;
        readonly command: string;
        readonly actor_id: string;
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
        readonly changed: unknown;
      }>(
        `select a.operation_id, a.command, a.actor_id, a.outcome, a.refusal_code,
                a.subject_record_id, o.result #> '{detail,changed}' as changed
           from public.audit_events a
           left join public.operations o
             on o.business_id = a.business_id and o.operation_id = a.operation_id
          where a.business_id = $1 and a.operation_id = any($2::text[])
          order by a.seq`,
        [alpha, [description, brief, refusal]],
      );
      const applied = { command: 'task.update', actor_id: writer.actorId, outcome: 'applied' };
      expect(events).toEqual([
        {
          ...applied,
          operation_id: description,
          refusal_code: null,
          subject_record_id: task.recordId,
          changed: ['description'],
        },
        {
          ...applied,
          operation_id: brief,
          refusal_code: null,
          subject_record_id: task.recordId,
          changed: ['agent_brief'],
        },
        {
          operation_id: refusal,
          command: 'task.update',
          actor_id: reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          subject_record_id: null,
          changed: null,
        },
      ]);
      // The change and its record committed together.
      expect(await held(task.recordId)).toMatchObject({ description: 'd', agent_brief: 'b' });
      const chain = await db.app.withBusiness(alpha, async (tx) => await verifyAuditChain(tx));
      expect(chain.intact).toBe(true);
    });
  });

  describe('MP-4-7 permission refusals: task:write', () => {
    it.each([['description'], ['agent_brief']])(
      'refuses %s to a caller without task:write and writes nothing',
      async (key) => {
        const task = await fresh(alpha, writer, CANARY);
        const answer = await write(alpha, reader, task, { [key]: 'mine' });
        expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
        expect(await held(task.recordId)).toMatchObject({
          revision: String(task.revision),
          description: null,
          agent_brief: null,
        });
        expect(JSON.stringify(answer)).not.toContain(task.recordId);
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      },
    );
  });

  describe('MP-4-7 isolation', () => {
    it('another business: its task is not found, never written, and its words never shown', async () => {
      const foreign = await fresh(bravo, bravoWriter, 'bravo’s', {
        agent_brief: CANARY,
        description: CANARY,
      });
      const answer = await write(alpha, writer, foreign, {
        agent_brief: 'overwritten',
        description: 'x',
      });
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await held(foreign.recordId)).toMatchObject({
        agent_brief: CANARY,
        description: CANARY,
      });
      const read = await readAs(alpha, writer, foreign.recordId);
      expect(outcomeOf(read as never)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(read)).not.toContain(CANARY);
    });

    it('another client in the same business: a writer on client A’s task cannot read or write client B’s', async () => {
      const taskA = await fresh(alpha, writer, 'client A');
      const taskB = await fresh(alpha, writer, 'client B', {
        agent_brief: CANARY,
        description: CANARY,
      });
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
        await grantTo(tx, clientAWriter, 'read', { kind: 'record', id: taskA.recordId });
      });
      expect(
        outcomeOf(await write(alpha, clientAWriter, taskA, { agent_brief: 'A' })),
      ).toStrictEqual({
        applied: true,
      });
      const refused = await write(alpha, clientAWriter, taskB, {
        agent_brief: 'B',
        description: 'B',
      });
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect(await held(taskB.recordId)).toMatchObject({
        agent_brief: CANARY,
        description: CANARY,
      });
      const read = await readAs(alpha, clientAWriter, taskB.recordId);
      expect(isCommandRefusal(read as never)).toBe(true);
      expect(JSON.stringify(read)).not.toContain(CANARY);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-7 isolation under a live delegation', () => {
  let world: AgentWorld;

  beforeAll(async () => {
    world = await agentWorld('wa', `writing-agent-${randomUUID().slice(0, 8)}`);
  }, 180_000);

  afterAll(async () => {
    await world?.drop();
  });

  const held = async (recordId: string) =>
    (
      await world.db.admin.execute<Held & { readonly title: string | null }>(
        `select revision::text as revision, data ->> 'description' as description,
                data ->> 'agent_brief' as agent_brief, txt_4 as title
           from public.records where id = $1`,
        [recordId],
      )
    )[0];

  const agentWrite = async (
    recordId: string,
    fields: Record<string, unknown>,
    credential: string,
  ) =>
    await world.asAgent(
      {
        command: 'task.update',
        operationId: randomUUID(),
        recordId,
        expectedRevision: Number((await held(recordId))?.revision),
        fields,
      },
      credential,
    );

  it('an agent writes the brief and the description on its own task, reads them back, and no other task', async () => {
    const decider = await world.decider('decider');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'someone else’s', agent_brief: CANARY },
    });
    const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
    const picked = await world.pickUp(decider, 'the agent’s task');

    const brief = await agentWrite(
      picked.taskId,
      { agent_brief: 'I will hold the spend.' },
      picked.credential,
    );
    expect(codeOf(brief)).toBe('not-a-refusal');
    const description = await agentWrite(
      picked.taskId,
      { description: 'Pacing.' },
      picked.credential,
    );
    expect(codeOf(description)).toBe('not-a-refusal');
    expect(await held(picked.taskId)).toMatchObject({
      agent_brief: 'I will hold the spend.',
      description: 'Pacing.',
    });
    // The agent boots on the brief, so its read carries it.
    const read = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    expect((detailOf(read)['task'] as Record<string, unknown>)['agentBrief']).toBe(
      'I will hold the spend.',
    );

    const foreign = await agentWrite(otherId, { agent_brief: 'overwritten' }, picked.credential);
    expect(codeOf(foreign)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect((await held(otherId))?.agent_brief).toBe(CANARY);
  });

  it('an agent writes nothing else through task.update, and a refusal writes nothing', async () => {
    const decider = await world.decider('decider-2');
    const picked = await world.pickUp(decider, 'kept title');
    const before = await held(picked.taskId);
    for (const fields of [
      { title: 'renamed' },
      { due: '2030-01-01' },
      { agent_brief: 'mixed', title: 'renamed' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each write reads the revision the last left
      const answer = await agentWrite(picked.taskId, fields, picked.credential);
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await held(picked.taskId)).toStrictEqual(before);
  });
});
