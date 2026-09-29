// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: subtasks as stored task records, against a real database.
//
// A subtask is a full task whose `parent` names another task (CS-15.19), so
// `task.read` carries the parent's steps, read with the parent in one query
// and filtered by the reader's own grants. A subtask carries its parent's
// business and client: it takes the client when it is made, a change of the
// parent's client carries down, and a subtask put under another client is
// refused. Every crossing plants a canary title a reader may not see and
// reads the whole body for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { readTaskFamily } from '../../packages/core-records/src/index.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/index.ts';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-steps: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Body = Readonly<Record<string, unknown>>;

const CANARY = `canary-${randomUUID()}`;
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();

let db: FreshDatabase | undefined;
let alpha: BusinessId;
let bravo: BusinessId;
let owner: Member;
let bravoOwner: Member;
let pairReader: Member;
let reader: Member;
const ids: Record<string, string> = {};

const seeded = (): FreshDatabase => {
  if (db === undefined) throw new Error('the steps database was not seeded');
  return db;
};

const send = async (business: BusinessId, member: Member, body: Body) =>
  await executeCommand(seeded().app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

const command = async (business: BusinessId, member: Member, body: Body) => {
  const answer = await send(business, member, body);
  if (isCommandRefusal(answer)) {
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  }
  return answer;
};

const revisionOf = async (recordId: string): Promise<number> => {
  const rows = await seeded().admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

const clientOf = async (recordId: string): Promise<string | null> => {
  const rows = await seeded().admin.execute<{ readonly client: string | null }>(
    `select uuid_7::text as client from public.records where id = $1`,
    [recordId],
  );
  return rows[0]?.client ?? null;
};

const make = async (
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

const read = async (business: BusinessId, member: Member, recordId: string) =>
  await executeRead(seeded().app, business, member.presented, { read: 'task.read', recordId });

const stepsOf = async (business: BusinessId, member: Member, recordId: string) => {
  const answer = await read(business, member, recordId);
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  return { steps: answer.task.steps, body: JSON.stringify(answer) };
};

const titles = (steps: readonly StepView[]): readonly (string | null)[] =>
  steps.map((step) => step.title);

async function seed(): Promise<void> {
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

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-4 subtask stored', () => {
  it('parent and children read back in one query', async () => {
    let queries = 0;
    const family = await seeded().app.withBusiness(alpha, async (tx) => {
      const counted: TenantQuery = {
        ...tx,
        query: async (sql, params) => {
          queries += 1;
          return await tx.query(sql, params);
        },
      };
      const types = await tx.query<{ readonly id: string }>(
        `select id from public.record_types where business_id = $1 and key = 'task'`,
        [alpha],
      );
      return await readTaskFamily(counted, types[0]?.id ?? '', ids['parent'] ?? '');
    });
    expect(queries).toBe(1);
    expect(family.parent?.id).toBe(ids['parent']);
    // The stray child is this business's, so the stored family holds it; the
    // grant filter on the read decides who is shown it.
    expect(family.children.map((child) => child.id).toSorted()).toStrictEqual(
      [ids['first'], ids['second'], ids['stray']].toSorted(),
    );
  });

  it('task.read carries the steps in their order, each a full task', async () => {
    const { steps } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    // In the order they were added; the planted stray is this business's own
    // and the owner reads the whole business, so it is a step here too.
    expect(titles(steps).filter((title) => title !== CANARY)).toStrictEqual([
      'Write the copy',
      'Check the forms',
    ]);
    const first = steps[0];
    expect(first?.id).toBe(ids['first']);
    expect(first?.key).toMatch(/^T-\d+$/u);
    expect(first?.done).toBe(false);
    expect(first?.archived).toBeNull();
    expect(first?.state?.machineCategory).toBe('unstarted');
    // A subtask is a task: it reads on its own, with a parent of its own.
    const own = await read(alpha, owner, ids['first'] ?? '');
    expect(isCommandRefusal(own)).toBe(false);
  });

  it('a subtask completed reads as done at once', async () => {
    const second = ids['second'] ?? '';
    await command(alpha, owner, {
      command: 'task.complete',
      recordId: second,
      expectedRevision: await revisionOf(second),
    });
    const { steps } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    expect(steps.find((step) => step.id === second)?.done).toBe(true);
    await command(alpha, owner, {
      command: 'task.reopen',
      recordId: second,
      expectedRevision: await revisionOf(second),
      reason: 'put back for the next case',
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 parent scope', () => {
  it('a subtask takes its parent’s client when it is made', async () => {
    expect(await clientOf(ids['first'] ?? '')).toBe(CLIENT_A);
    expect(await clientOf(ids['second'] ?? '')).toBe(CLIENT_A);
  });

  it('a subtask put under another client is refused, and nothing is written', async () => {
    const first = ids['first'] ?? '';
    const before = await revisionOf(first);
    const answer = await send(alpha, owner, {
      command: 'task.set_party',
      recordId: first,
      expectedRevision: before,
      fields: { client: CLIENT_B },
    });
    expect(codeOf(answer)).toBe('PLACEMENT_IS_DERIVED');
    expect(JSON.stringify(answer)).not.toContain(CLIENT_B);
    expect(await revisionOf(first)).toBe(before);
    expect(await clientOf(first)).toBe(CLIENT_A);
  });

  it('a task moved under another client’s parent is refused', async () => {
    const lone = await make(alpha, owner, 'lone', 'client B errand', { client: CLIENT_B });
    const before = await revisionOf(lone);
    const answer = await send(alpha, owner, {
      command: 'task.reparent',
      recordId: lone,
      expectedRevision: before,
      parentId: ids['parent'],
    });
    expect(codeOf(answer)).toBe('PLACEMENT_IS_DERIVED');
    expect(await revisionOf(lone)).toBe(before);
  });

  it('a subtask named under another business’s task is refused, and nothing is made', async () => {
    const answer = await send(alpha, owner, {
      command: 'task.create',
      fields: { title: 'across' },
      parentId: ids['foreign'],
    });
    expect(isCommandRefusal(answer)).toBe(true);
    const made = await seeded().admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records where data ->> 'title' = 'across'`,
    );
    expect(made[0]?.n).toBe('0');
  });

  it('the parent’s client changed carries down to its subtasks, in the same act', async () => {
    const parent = await make(alpha, owner, 'moving', 'Rebrand', { client: CLIENT_A });
    const child = await make(alpha, owner, 'movingChild', 'Logo', { parentId: parent });
    const grandchild = await make(alpha, owner, 'movingGrand', 'Colours', { parentId: child });
    await command(alpha, owner, {
      command: 'task.set_party',
      recordId: parent,
      expectedRevision: await revisionOf(parent),
      fields: { client: CLIENT_B },
    });
    expect(await clientOf(child)).toBe(CLIENT_B);
    expect(await clientOf(grandchild)).toBe(CLIENT_B);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 audit read-back', () => {
  it('adding and completing a subtask each join the audit chain', async () => {
    const [created, completed] = [randomUUID(), randomUUID()];
    const made = await command(alpha, owner, {
      command: 'task.create',
      operationId: created,
      fields: { title: 'audited step' },
      parentId: ids['parent'],
    });
    const step = made.recordId ?? '';
    await command(alpha, owner, {
      command: 'task.complete',
      operationId: completed,
      recordId: step,
      expectedRevision: await revisionOf(step),
    });
    const events = await seeded().admin.execute<{
      readonly command: string;
      readonly actor_id: string;
      readonly outcome: string;
      readonly subject_record_id: string | null;
    }>(
      `select command, actor_id, outcome, subject_record_id from public.audit_events
        where business_id = $1 and operation_id = any($2::text[]) order by seq`,
      [alpha, [created, completed]],
    );
    expect(events).toEqual([
      {
        command: 'task.create',
        actor_id: owner.actorId,
        outcome: 'applied',
        subject_record_id: step,
      },
      {
        command: 'task.complete',
        actor_id: owner.actorId,
        outcome: 'applied',
        subject_record_id: step,
      },
    ]);
    const chain = await seeded().app.withBusiness(alpha, async (tx) => await verifyAuditChain(tx));
    expect(chain.intact).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 task:write refused', () => {
  it('a reader adds no subtask and ticks none, and nothing is written', async () => {
    const add = await send(alpha, reader, {
      command: 'task.create',
      fields: { title: 'reader step' },
      parentId: ids['parent'],
    });
    expect(codeOf(add)).toBe('SCOPE_NOT_GRANTED');
    const first = ids['first'] ?? '';
    const before = await revisionOf(first);
    const tick = await send(alpha, reader, {
      command: 'task.complete',
      recordId: first,
      expectedRevision: before,
    });
    expect(codeOf(tick)).toBe('SCOPE_NOT_GRANTED');
    expect(await revisionOf(first)).toBe(before);
    const { steps } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    expect(titles(steps)).not.toContain('reader step');
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 isolation', () => {
  it('another business: its task pointing at the parent is never a step', async () => {
    const { steps, body } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    expect(steps.map((step) => step.id)).not.toContain(ids['foreign']);
    expect(body).not.toContain(ids['foreign']);
    const across = await read(alpha, owner, ids['foreign'] ?? '');
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('NOT_FOUND');
  });

  it('another client in the same business: a reader of the parent sees only the steps they hold', async () => {
    const { steps, body } = await stepsOf(alpha, pairReader, ids['parent'] ?? '');
    expect(titles(steps)).toStrictEqual(['Write the copy']);
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain(ids['stray']);
    expect(body).not.toContain(ids['second']);
    const direct = await read(alpha, pairReader, ids['stray'] ?? '');
    expect(isCommandRefusal(direct) ? direct.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(direct)).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-4 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('sta', `steps-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('reads no step of its task, and no subtask title reaches it', async () => {
      const decider = await world.decider('decider');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const made = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
        parentId: picked.taskId,
      });
      expect(isCommandRefusal(made)).toBe(false);
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { steps: unknown };
      expect(task.steps).toStrictEqual([]);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const step = isCommandRefusal(made) ? '' : (made.recordId ?? '');
      const direct = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: step },
        picked.credential,
      );
      expect(isCommandRefusal(direct)).toBe(true);
      expect(JSON.stringify(direct)).not.toContain(CANARY);
    });
  },
);
