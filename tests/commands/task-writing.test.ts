// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-7: the description and the agent brief (CS-4.23, CS-4.24).
//
// Both are ordinary task text, written through `task.update` under
// `task:write` and audited as that command with the field named in its
// `changed` list: `task.description changed` and `task.agent brief changed`
// are its two tracked actions. The brief is a task field of its own
// (`agent_brief`, migration 0035), unslotted like the description, internal
// like it: a client's shared view carries neither. The agent's reach is
// `task-writing-agent.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { grantTo } from './fixture.ts';
import { briefOf, outcomeOf, writingWorld, type WritingWorld } from './writing-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-writing: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const CANARY = `canary-${randomUUID()}`;

let w: WritingWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await writingWorld();
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-7 description and agent brief', () => {
  it('the brief is a task field of its own: text, unslotted, generic, internal, core', async () => {
    const rows = await w.db.admin.execute<Record<string, unknown>>(
      `select f.key, f.value_type, f.slot, f.write_mode, f.owning_operation, f.visibility_class, f.origin
         from public.field_defs f
         join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
        where f.business_id = $1 and t.key = 'task' and f.key in ('agent_brief', 'description')
        order by f.key`,
      [w.alpha],
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
});

describe.skipIf(serverUrl === undefined)('MP-4-7 CS-4.24 write the description', () => {
  it('saves the description, and the read gives it back', async () => {
    const task = await w.fresh(w.alpha, w.writer, 'described');
    const answer = await w.write(w.alpha, w.writer, task, { description: 'Fix the pacing.' });
    expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    expect((await w.held(task.recordId))?.description).toBe('Fix the pacing.');
    const read = await w.readAs(w.alpha, w.writer, task.recordId);
    expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.description).toBe(
      'Fix the pacing.',
    );
  });

  it('clears it with null', async () => {
    const task = await w.fresh(w.alpha, w.writer, 'cleared', { description: 'was here' });
    const answer = await w.write(w.alpha, w.writer, task, { description: null });
    expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    expect((await w.held(task.recordId))?.description).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-7 CS-4.23 write the agent brief', () => {
  it('saves the brief whole, markdown and all, and the read gives it back', async () => {
    const brief = '# Brief\n**Objective:** hold the spend.\n\n- one\n- two\n';
    const task = await w.fresh(w.alpha, w.writer, 'briefed');
    const answer = await w.write(w.alpha, w.writer, task, { agent_brief: brief });
    expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    expect((await w.held(task.recordId))?.agent_brief).toBe(brief);
    const read = await w.readAs(w.alpha, w.writer, task.recordId);
    expect(isCommandRefusal(read) || !('task' in read) ? null : briefOf(read.task)).toBe(brief);
  });

  it('reads null where none has been written', async () => {
    const task = await w.fresh(w.alpha, w.writer, 'unbriefed');
    const read = await w.readAs(w.alpha, w.writer, task.recordId);
    expect(isCommandRefusal(read) || !('task' in read) ? undefined : briefOf(read.task)).toBeNull();
  });

  it.each([
    ['a number', 7],
    ['an object', { text: 'x' }],
    ['a list', ['x']],
  ])('refuses %s as the brief and writes nothing', async (_label, value) => {
    const task = await w.fresh(w.alpha, w.writer, 'hostile');
    const answer = await w.write(w.alpha, w.writer, task, { agent_brief: value });
    expect(outcomeOf(answer)).toMatchObject({ code: 'FIELD_VALUE_INVALID' });
    expect(Number((await w.held(task.recordId))?.revision)).toBe(task.revision);
  });
});

interface AuditRow {
  readonly operation_id: string;
  readonly command: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly refusal_code: string | null;
  readonly subject_record_id: string | null;
  readonly changed: unknown;
}

// The audit row names the command; the field it changed is in the result the
// register stored in the same transaction, found by the operation.
const auditOf = async (operations: readonly string[]) =>
  await w.db.admin.execute<AuditRow>(
    `select a.operation_id, a.command, a.actor_id, a.outcome, a.refusal_code,
            a.subject_record_id, o.result #> '{detail,changed}' as changed
       from public.audit_events a
       left join public.operations o
         on o.business_id = a.business_id and o.operation_id = a.operation_id
      where a.business_id = $1 and a.operation_id = any($2::text[])
      order by a.seq`,
    [w.alpha, operations],
  );

describe.skipIf(serverUrl === undefined)(
  'MP-4-7 audit read-back: task.description changed, task.agent brief changed',
  () => {
    it('each change and its refusal join the audit chain as task.update, the field named', async () => {
      const task = await w.fresh(w.alpha, w.writer, 'audited');
      const [description, brief, refusal] = [randomUUID(), randomUUID(), randomUUID()];
      const next = (by: number) => ({ ...task, revision: task.revision + by });
      await w.write(w.alpha, w.writer, task, { description: 'd' }, description);
      await w.write(w.alpha, w.writer, next(1), { agent_brief: 'b' }, brief);
      await w.write(w.alpha, w.reader, next(2), { agent_brief: 'x' }, refusal);
      const applied = { command: 'task.update', actor_id: w.writer.actorId, outcome: 'applied' };
      const stored = { refusal_code: null, subject_record_id: task.recordId };
      // `toEqual`: the driver's rows are not plain objects.
      expect(await auditOf([description, brief, refusal])).toEqual([
        { ...applied, ...stored, operation_id: description, changed: ['description'] },
        { ...applied, ...stored, operation_id: brief, changed: ['agent_brief'] },
        {
          operation_id: refusal,
          command: 'task.update',
          actor_id: w.reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          subject_record_id: null,
          changed: null,
        },
      ]);
      // The change and its record committed together.
      expect(await w.held(task.recordId)).toMatchObject({ description: 'd', agent_brief: 'b' });
      const chain = await w.db.app.withBusiness(w.alpha, async (tx) => await verifyAuditChain(tx));
      expect(chain.intact).toBe(true);
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-7 permission refusals: task:write', () => {
  it.each([['description'], ['agent_brief']])(
    'refuses %s to a caller without task:write and writes nothing',
    async (key) => {
      const task = await w.fresh(w.alpha, w.writer, CANARY);
      const answer = await w.write(w.alpha, w.reader, task, { [key]: 'mine' });
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(await w.held(task.recordId)).toMatchObject({
        revision: String(task.revision),
        description: null,
        agent_brief: null,
      });
      expect(JSON.stringify(answer)).not.toContain(task.recordId);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    },
  );
});

describe.skipIf(serverUrl === undefined)('MP-4-7 isolation', () => {
  it('another business: its task is not found, never written, and its words never shown', async () => {
    const words = { agent_brief: CANARY, description: CANARY };
    const foreign = await w.fresh(w.bravo, w.bravoWriter, 'bravo’s', words);
    const answer = await w.write(w.alpha, w.writer, foreign, {
      agent_brief: 'x',
      description: 'x',
    });
    expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await w.held(foreign.recordId)).toMatchObject(words);
    const read = await w.readAs(w.alpha, w.writer, foreign.recordId);
    expect(outcomeOf(read as never)).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });

  it('another client in the same business: a writer on client A’s task cannot read or write client B’s', async () => {
    const words = { agent_brief: CANARY, description: CANARY };
    const taskA = await w.fresh(w.alpha, w.writer, 'client A');
    const taskB = await w.fresh(w.alpha, w.writer, 'client B', words);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      const scope = { kind: 'record', id: taskA.recordId } as const;
      await grantTo(tx, w.clientAWriter, 'write', scope);
      await grantTo(tx, w.clientAWriter, 'read', scope);
    });
    const own = await w.write(w.alpha, w.clientAWriter, taskA, { agent_brief: 'A' });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    const refused = await w.write(w.alpha, w.clientAWriter, taskB, { agent_brief: 'B' });
    expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    expect(await w.held(taskB.recordId)).toMatchObject(words);
    const read = await w.readAs(w.alpha, w.clientAWriter, taskB.recordId);
    expect(isCommandRefusal(read as never)).toBe(true);
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });
});
