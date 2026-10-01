// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: what a subtask's commands write, against a real database. A
// subtask carries its parent's client (`MP-4-4 parent scope`), adding and
// ticking one joins the audit chain (`MP-4-4 audit read-back`), and a reader
// without `task:write` adds and ticks nothing (`MP-4-4 task:write refused`).
// The seeded world is `tests/reads/steps-world.ts`.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
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

/** `task.set_party` on a task, which must apply. */
async function moveTo(task: string, client: string): Promise<void> {
  await command(alpha, owner, {
    command: 'task.set_party',
    recordId: task,
    expectedRevision: await revisionOf(task),
    fields: { client },
  });
}

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
    // The control: before it has a subtask, the same change applies.
    await moveTo(parent, CLIENT_B);
    await moveTo(parent, CLIENT_A);
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

describe.skipIf(serverUrl === undefined)('MP-4-4 parent scope, a trashed subtask', () => {
  // The lock counts a trashed subtask: carry-down walks live rows and restore
  // asks no client, so a parent that moved would get it back on the old one.
  it('a parent whose only subtask is in the trash keeps its client', async () => {
    const parent = await make(alpha, owner, 'binned', 'Brochure', { client: CLIENT_A });
    const child = await make(alpha, owner, 'binnedChild', 'Proofs', { parentId: parent });
    const trashed = await command(alpha, owner, {
      command: 'task.trash',
      recordId: child,
      expectedRevision: await revisionOf(child),
    });
    const answer = await send(alpha, owner, {
      command: 'task.set_party',
      recordId: parent,
      expectedRevision: await revisionOf(parent),
      fields: { client: CLIENT_B },
    });
    expect(codeOf(answer)).toBe('CLIENT_LOCKED');
    await command(alpha, owner, { command: 'task.restore', batchId: trashed.detail['batchId'] });
    expect([await clientOf(parent), await clientOf(child)]).toEqual([CLIENT_A, CLIENT_A]);
  });
});

/** A promise and the one call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

/** A connection of its own whose transactions stay open after their work until `held` opens. */
function heldOpen(url: string, worked: () => void, held: Promise<void>): Database {
  const database = connect(url, { source: 'runtime' });
  return {
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (business, run) =>
      await database.withBusiness(business, async (tx) => {
        const out = await run(tx);
        worked();
        await held;
        return out;
      }),
  };
}

/** Until some session in this database waits on a lock. */
async function untilOneWaits(): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling, one look at a time
    const [row] = await seeded().admin.execute<{ readonly waiting: boolean }>(
      `select exists (select 1 from pg_locks where not granted and pid in
         (select pid from pg_stat_activity where datname = current_database())) as waiting`,
    );
    if (row?.waiting === true) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(20);
  }
  throw new Error('no session ever waited on a lock');
}

describe.skipIf(serverUrl === undefined)('MP-4-4 parent scope, raced', () => {
  // T1 moves an empty parent to B, held open; a reparent of an A task under it must see B.
  it('a reparent racing the parent’s client change never leaves a child on another client', async () => {
    const parent = await make(alpha, owner, 'racedParent', 'Campaign', { client: CLIENT_A });
    const moving = await make(alpha, owner, 'racedChild', 'Banner', { client: CLIENT_A });
    const under = await make(alpha, owner, 'racedGrand', 'Sizes', { parentId: moving });
    const [worked, gate] = [latch(), latch()];
    const held = heldOpen(seeded().appUrl, worked.open, gate.promise);
    const changing = executeCommand(held, alpha, owner.presented, 'api', {
      operationId: randomUUID(),
      command: 'task.set_party',
      recordId: parent,
      expectedRevision: await revisionOf(parent),
      fields: { client: CLIENT_B },
    } as never);
    let reparenting: ReturnType<typeof send> | undefined;
    try {
      await worked.promise;
      reparenting = send(alpha, owner, {
        command: 'task.reparent',
        recordId: moving,
        expectedRevision: await revisionOf(moving),
        parentId: parent,
      });
      await untilOneWaits();
    } finally {
      gate.open();
    }
    expect(isCommandRefusal(await changing)).toBe(false);
    await held.close();
    const answer = await reparenting;
    const [placed] = await seeded().admin.execute<{ readonly parent: string | null }>(
      `select data ->> 'parent' as parent from public.records where id = $1`,
      [moving],
    );
    if (placed?.parent === parent) {
      expect([await clientOf(moving), await clientOf(under)]).toEqual([CLIENT_B, CLIENT_B]);
    } else {
      expect(codeOf(answer)).toBe('PLACEMENT_IS_DERIVED');
      expect(await clientOf(moving)).toBe(CLIENT_A);
    }
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
