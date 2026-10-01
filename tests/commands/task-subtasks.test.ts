// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: what a subtask's commands write, against a real database. A
// subtask carries its parent's client (`MP-4-4 parent scope`), adding and
// ticking one joins the audit chain (`MP-4-4 audit read-back`), and a reader
// without `task:write` adds and ticks nothing (`MP-4-4 task:write refused`).
// The seeded world is `tests/reads/steps-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { codeOf } from './agent-fixture.ts';
import {
  serverUrl,
  CLIENT_A,
  CLIENT_B,
  alpha,
  owner,
  reader,
  ids,
  seeded,
  send,
  command,
  revisionOf,
  clientOf,
  make,
  stepsOf,
  titles,
  seed,
  dropSteps,
} from '../reads/steps-world.ts';

if (serverUrl === undefined) {
  console.warn('task-subtasks: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 180_000);

afterAll(dropSteps);

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
});

describe.skipIf(serverUrl === undefined)('MP-4-4 parent scope', () => {
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

  // S0-5 (owner line 75) counts a subtask as its parent's content, so a parent's
  // client is locked once it has one, and its subtree keeps the client it had.
  it('the parent’s client is locked once it has subtasks, and nothing moves down', async () => {
    const parent = await make(alpha, owner, 'moving', 'Rebrand', { client: CLIENT_A });
    const child = await make(alpha, owner, 'movingChild', 'Logo', { parentId: parent });
    const grandchild = await make(alpha, owner, 'movingGrand', 'Colours', { parentId: child });
    const answer = await send(alpha, owner, {
      command: 'task.set_party',
      recordId: parent,
      expectedRevision: await revisionOf(parent),
      fields: { client: CLIENT_B },
    });
    expect(codeOf(answer)).toBe('CLIENT_LOCKED');
    expect(await clientOf(parent)).toBe(CLIENT_A);
    expect(await clientOf(child)).toBe(CLIENT_A);
    expect(await clientOf(grandchild)).toBe(CLIENT_A);
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
