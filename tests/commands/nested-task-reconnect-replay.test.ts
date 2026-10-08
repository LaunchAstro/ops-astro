// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  alpha,
  owner,
  pairReader,
  CLIENT_A,
  seed,
  seeded,
  serverUrl,
  dropSteps,
  make,
  command,
  revisionOf,
  stepsOf,
} from '../reads/steps-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 180_000);
afterAll(dropSteps);

async function detail(database: Database, recordId: string) {
  const answer = await executeRead(database, alpha, owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (!('task' in answer)) throw new Error('Nested task read did not answer a task');
  return answer.task;
}

async function samePlacement(parent: string, child: string, grandchild: string): Promise<void> {
  const rows = await seeded().admin.execute<{
    readonly id: string;
    readonly business_id: string;
    readonly client: string;
    readonly parent: string | null;
  }>(
    "select id::text, business_id::text, uuid_7::text as client, data ->> 'parent' as parent from public.records where id = any($1::uuid[]) order by id",
    [[parent, child, grandchild]],
  );
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.business_id === alpha && row.client === CLIENT_A)).toBe(true);
  expect(rows.find((row) => row.id === child)?.parent).toBe(parent);
  expect(rows.find((row) => row.id === grandchild)?.parent).toBe(child);
}

async function oneCreate(operationId: string, parent: string, child: string): Promise<void> {
  const effects = await seeded().admin.execute<{ readonly n: string }>(
    "select count(*)::text as n from public.records where business_id = $1 and data ->> 'parent' = $2 and data ->> 'title' = 'Nested child'",
    [alpha, parent],
  );
  expect(effects[0]?.n).toBe('1');
  const attempts = await seeded().admin.execute<{
    readonly outcome: string;
    readonly subject_record_id: string;
  }>(
    "select outcome, subject_record_id::text from public.audit_events where business_id = $1 and command = 'task.create' and operation_id = $2 order by seq",
    [alpha, operationId],
  );
  expect(attempts).toEqual([
    { outcome: 'applied', subject_record_id: child },
    { outcome: 'replayed', subject_record_id: child },
  ]);
}

async function lifecycle(
  database: Database,
  parent: string,
  child: string,
  grandchild: string,
): Promise<void> {
  const opened = await detail(database, child);
  await command(alpha, owner, {
    command: 'task.complete',
    recordId: child,
    expectedRevision: opened.revision,
  });
  const completed = await detail(database, child);
  expect(completed.completedAt).not.toBeNull();
  expect(completed.steps.find((step) => step.id === grandchild)?.archived).not.toBeNull();
  expect((await detail(database, parent)).steps.find((step) => step.id === child)?.done).toBe(true);
  await command(alpha, owner, {
    command: 'task.reopen',
    recordId: child,
    expectedRevision: completed.revision,
    reason: 'More nested work',
  });
  const reopened = await detail(database, child);
  expect(reopened.completedAt).toBeNull();
  expect(reopened.steps.find((step) => step.id === grandchild)).toMatchObject({
    done: false,
    archived: null,
  });
  expect((await detail(database, parent)).steps.find((step) => step.id === child)?.done).toBe(
    false,
  );
}

describe.skipIf(serverUrl === undefined)('nested task durability and authority', () => {
  it('a fresh connection reads the committed family, replays one child create, and reads child completion and reopen', async () => {
    const parent = await make(alpha, owner, 'nested-parent', 'Nested parent', { client: CLIENT_A });
    const operationId = randomUUID();
    const request = {
      command: 'task.create' as const,
      operationId,
      parentId: parent,
      fields: { title: 'Nested child' },
    };
    const created = await command(alpha, owner, request);
    const child = created.recordId;
    if (child === null) throw new Error('Child create omitted its identity');
    const grandchild = await make(alpha, owner, 'nested-grandchild', 'Nested grandchild', {
      parentId: child,
    });
    const reconnected = connect(seeded().appUrl, { source: 'runtime' });
    try {
      expect((await detail(reconnected, parent)).steps.map((step) => step.id)).toEqual([child]);
      expect((await detail(reconnected, child)).steps.map((step) => step.id)).toEqual([grandchild]);
      expect((await detail(reconnected, grandchild)).title).toBe('Nested grandchild');
      await samePlacement(parent, child, grandchild);
      const replayed = await executeCommand(reconnected, alpha, owner.presented, 'api', request);
      expect(replayed).toEqual(created);
      await oneCreate(operationId, parent, child);
      await lifecycle(reconnected, parent, child, grandchild);
    } finally {
      await reconnected.close();
    }
  });
});

describe.skipIf(serverUrl === undefined)('nested task parent-only authority', () => {
  it('a parent-only grant exposes no ungranted child or grandchild name, owner, identity or count', async () => {
    const parent = await make(alpha, owner, 'restricted-parent', 'Restricted parent', {
      client: CLIENT_A,
    });
    const child = await make(alpha, owner, 'restricted-child', 'Hidden nested child', {
      parentId: parent,
    });
    const grandchild = await make(
      alpha,
      owner,
      'restricted-grandchild',
      'Hidden nested grandchild',
      { parentId: child },
    );
    const hiddenOwner = await enrol(seeded().app, alpha, 'Hidden nested owner');
    await seeded().app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, owner, 'assign', { kind: 'record', id: child });
      await grantTo(tx, pairReader, 'read', { kind: 'record', id: parent });
    });
    await command(alpha, owner, {
      command: 'task.assign',
      recordId: child,
      expectedRevision: await revisionOf(child),
      fields: { assignee: hiddenOwner.personId },
    });
    const allowed = await stepsOf(alpha, pairReader, parent);
    expect(allowed.steps).toEqual([]);
    for (const canary of [
      child,
      grandchild,
      'Hidden nested child',
      'Hidden nested grandchild',
      hiddenOwner.personId,
      'Hidden nested owner',
    ]) {
      expect(allowed.body).not.toContain(canary);
    }
    const direct = await executeRead(seeded().app, alpha, pairReader.presented, {
      read: 'task.read',
      recordId: child,
    });
    expect(isCommandRefusal(direct) ? direct.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(direct)).not.toContain('Hidden nested child');
    const control = await detail(seeded().app, parent);
    expect(control.steps).toHaveLength(1);
    expect(control.steps[0]?.assignee?.personId).toBe(hiddenOwner.personId);
    expect(control.steps[0]?.assignee?.name).toBe('Hidden nested owner');
  });
});
