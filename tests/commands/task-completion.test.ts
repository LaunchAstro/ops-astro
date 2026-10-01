// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-15: one completion transition for a task, against a real database.
// `task.complete` is the one act the board tick, the status select and the
// Projects panel's tick all send. Completing a task marks its unfinished
// steps archived, never done, saying when and why; `task.reopen` restores
// exactly those, in the state each was left in. The counts the page draws
// agree at once, because they are read from the same steps. The seeded world
// is `tests/reads/steps-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo, enrol, type Member } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import {
  perspectiveCounts,
  stepMarks,
} from '../../apps/web/src/screens/task/perspective-counts.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import {
  alpha,
  command,
  dropSteps,
  ids,
  make,
  owner,
  read,
  revisionOf,
  seed,
  seeded,
  send,
  serverUrl,
  stepsOf,
} from '../reads/steps-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-completion: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let parentWriter: Member;
let reader: Member;

const stored = async (recordId: string) => {
  const rows = await seeded().admin.execute<{
    readonly state: string | null;
    readonly archived_at: string | null;
    readonly archived_why: string | null;
  }>(
    `select data ->> 'state' as state, data ->> 'archived_at' as archived_at,
            data ->> 'archived_why' as archived_why
       from public.records where id = $1`,
    [recordId],
  );
  return rows[0];
};

const complete = async (member: Member, recordId: string, operationId = randomUUID()) =>
  await send(alpha, member, {
    command: 'task.complete',
    operationId,
    recordId,
    expectedRevision: await revisionOf(recordId),
  });

const reopen = async (member: Member, recordId: string, operationId = randomUUID()) =>
  await send(alpha, member, {
    command: 'task.reopen',
    operationId,
    recordId,
    expectedRevision: await revisionOf(recordId),
    reason: 'More to do',
  });

/** A parent with one step done and two unfinished, one of them started. */
const family = async (name: string) => {
  const parent = await make(alpha, owner, name, `${name} parent`);
  const done = await make(alpha, owner, `${name}Done`, 'done step', { parentId: parent });
  const open = await make(alpha, owner, `${name}Open`, 'open step', { parentId: parent });
  const started = await make(alpha, owner, `${name}Started`, 'started step', { parentId: parent });
  await command(alpha, owner, {
    command: 'task.complete',
    recordId: done,
    expectedRevision: await revisionOf(done),
  });
  await command(alpha, owner, {
    command: 'task.start',
    recordId: started,
    expectedRevision: await revisionOf(started),
  });
  return { parent, done, open, started };
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await seed();
  const d = seeded();
  parentWriter = await enrol(d.app, alpha, 'parent-writer');
  reader = await enrol(d.app, alpha, 'completion-reader');
  await d.app.withBusiness(alpha, async (tx) => {
    const parent = { kind: 'record', id: ids['parent'] ?? '' } as const;
    await grantTo(tx, parentWriter, 'read', parent);
    await grantTo(tx, parentWriter, 'write', parent);
    await grantTo(tx, reader, 'read');
  });
}, 180_000);

afterAll(dropSteps);

describe.skipIf(serverUrl === undefined)('MP-4-15 unfinished steps archived', () => {
  it('completing marks each unfinished step archived, never done, saying when and why', async () => {
    const { parent, done, open, started } = await family('arch');
    const startedState = (await stored(started))?.state;
    expect(isCommandRefusal(await complete(owner, parent))).toBe(false);
    const { steps } = await stepsOf(alpha, owner, parent);
    const byId = new Map(steps.map((step) => [step.id, step]));
    expect(byId.get(done)?.archived).toBeNull();
    expect(byId.get(done)?.done).toBe(true);
    for (const id of [open, started]) {
      expect(byId.get(id)?.done).toBe(false);
      expect(byId.get(id)?.archived).toStrictEqual({
        at: expect.any(String) as unknown,
        why: 'The parent task was completed.',
      });
    }
    // Never done: the state each was in is the state it keeps.
    expect((await stored(started))?.state).toBe(startedState);
  });

  it('an archived step leaves the rank: it is not open work', async () => {
    const { parent, open } = await family('rank');
    await command(alpha, owner, {
      command: 'task.set_scores',
      recordId: open,
      expectedRevision: await revisionOf(open),
      fields: { impact: 8, confidence: 8, ease: 8 },
    });
    const rankOf = async () => {
      const answer = await read(alpha, owner, open);
      if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('no task');
      return answer.task.rank.number;
    };
    expect(await rankOf()).not.toBeNull();
    await complete(owner, parent);
    expect(await rankOf()).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-15 reopen restores', () => {
  it('reopening brings back exactly the steps the completion archived, as they were', async () => {
    const { parent, done, open, started } = await family('back');
    const before = await Promise.all([open, started].map(async (id) => (await stored(id))?.state));
    await complete(owner, parent);
    expect(isCommandRefusal(await reopen(owner, parent))).toBe(false);
    const { steps } = await stepsOf(alpha, owner, parent);
    expect(steps.every((step) => step.archived === null)).toBe(true);
    const after = await Promise.all([open, started].map(async (id) => (await stored(id))?.state));
    expect(after).toStrictEqual(before);
    expect(steps.find((step) => step.id === done)?.done).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('CS-4.2 one completion transition', () => {
  it('every count agrees at once after a completion and after a reopen', async () => {
    const { parent } = await family('agree');
    const team = async () => {
      const answer = await read(alpha, owner, parent);
      if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('no task');
      const counts = perspectiveCounts({
        steps: stepMarks(answer.task.steps),
        proposals: answer.task.proposals ?? [],
        stagedOutput: false,
      });
      return { team: counts.team, completed: answer.task.completedAt !== null };
    };
    expect(await team()).toStrictEqual({ team: 2, completed: false });
    await complete(owner, parent);
    expect(await team()).toStrictEqual({ team: 0, completed: true });
    await reopen(owner, parent);
    expect(await team()).toStrictEqual({ team: 2, completed: false });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-15 audit read-back', () => {
  it('the completion and the reopen each join the audit chain as the task’s own event', async () => {
    const { parent } = await family('audit');
    const [completed, reopened] = [randomUUID(), randomUUID()];
    await complete(owner, parent, completed);
    await reopen(owner, parent, reopened);
    const events = await seeded().admin.execute<{
      readonly command: string;
      readonly outcome: string;
      readonly subject_record_id: string | null;
    }>(
      `select command, outcome, subject_record_id from public.audit_events
        where business_id = $1 and operation_id = any($2::text[]) order by seq`,
      [alpha, [completed, reopened]],
    );
    expect(events).toEqual([
      { command: 'task.complete', outcome: 'applied', subject_record_id: parent },
      { command: 'task.reopen', outcome: 'applied', subject_record_id: parent },
    ]);
    const chain = await seeded().app.withBusiness(alpha, async (tx) => await verifyAuditChain(tx));
    expect(chain.intact).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-15 task:write refused', () => {
  it('a reader completes and reopens nothing, and no step is archived', async () => {
    const { parent, open } = await family('refused');
    expect(codeOf(await complete(reader, parent))).toBe('SCOPE_NOT_GRANTED');
    expect((await stored(open))?.archived_at).toBeNull();
    await complete(owner, parent);
    expect(codeOf(await reopen(reader, parent))).toBe('SCOPE_NOT_GRANTED');
    expect((await stored(open))?.archived_at).not.toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-15 isolation', () => {
  it('another business: its task pointing at the parent is never archived', async () => {
    const parent = ids['parent'] ?? '';
    await complete(owner, parent);
    expect((await stored(ids['foreign'] ?? ''))?.archived_at).toBeNull();
    expect((await stored(ids['first'] ?? ''))?.archived_at).not.toBeNull();
    await reopen(owner, parent);
  });

  it('another client in the same business: a writer of the parent alone archives no step they cannot write', async () => {
    const parent = ids['parent'] ?? '';
    const before = await revisionOf(parent);
    const answer = await complete(parentWriter, parent);
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(answer)).not.toContain(ids['stray']);
    expect(await revisionOf(parent)).toBe(before);
    expect((await stored(ids['stray'] ?? ''))?.archived_at).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-15 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('tca', `completion-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('completes nothing, so no step of its task is archived', async () => {
      const decider = await world.decider('decider');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const made = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'a step' },
        parentId: picked.taskId,
      });
      const step = isCommandRefusal(made) ? '' : (made.recordId ?? '');
      const rows = await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [picked.taskId],
      );
      const answer = await world.asAgent(
        {
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: picked.taskId,
          expectedRevision: Number(rows[0]?.revision),
        },
        picked.credential,
      );
      expect(isCommandRefusal(answer)).toBe(true);
      const archived = await world.db.admin.execute<{ readonly at: string | null }>(
        `select data ->> 'archived_at' as at from public.records where id = $1`,
        [step],
      );
      expect(archived[0]?.at).toBeNull();
    });
  },
);
