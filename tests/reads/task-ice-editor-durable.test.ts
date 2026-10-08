// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  iceWorld,
  iceCommand,
  newIceTask,
  icePage,
  iceBoard,
  handle,
  type IceWorld,
} from './task-ice-editor-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { grantTo, shareWithClient, enrol } from '../commands/fixture.ts';
import { agentWorld } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';

let world: IceWorld;
beforeAll(async () => {
  world = await iceWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

it('the owning score command persists three typed internal marks and reads the same page/board calculation after reconnect', async () => {
  const made = await newIceTask(world);
  const initial = await icePage(world, made.id);
  const request = {
    command: 'task.set_scores',
    operationId: randomUUID(),
    recordId: made.id,
    expectedRevision: initial.revision,
    fields: { impact: 7, confidence: 9, ease: 8 },
  } as const;
  const applied = await iceCommand(world, request);
  handle(applied);
  await world.db.closeSessions();
  const page = await icePage(world, made.id);
  expect(page).toHaveProperty('scores', { impact: 7, confidence: 9, ease: 8 });
  expect(page.revision).toBe(initial.revision + 1);
  const board = (await iceBoard(world)).find((task) => task.id === made.id);
  expect(board).not.toHaveProperty('scores');
  expect(board?.rank).toStrictEqual(page.rank);
  expect(page.rank.calc).not.toBe('');
  expect(await iceCommand(world, request)).toStrictEqual(applied);
  expect((await icePage(world, made.id)).revision).toBe(page.revision);
  const audit = await world.db.app.withBusiness(world.business, readAuditEvents);
  expect(
    audit.filter(
      (event) => event.operation_id === request.operationId && event.outcome === 'applied',
    ),
  ).toHaveLength(1);
});

it('unset and explicitly cleared marks remain null and unscored through the owning command', async () => {
  const made = await newIceTask(world);
  expect(await icePage(world, made.id)).toHaveProperty('scores', {
    impact: null,
    confidence: null,
    ease: null,
  });
  const marked = handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { impact: 1, confidence: 10, ease: 5 },
    }),
  );
  const cleared = handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: made.id,
      expectedRevision: marked.revision,
      fields: { impact: null },
    }),
  );
  await world.db.closeSessions();
  const page = await icePage(world, made.id);
  expect(page).toHaveProperty('scores', { impact: null, confidence: 10, ease: 5 });
  expect(page.revision).toBe(cleared.revision);
  expect(page.rank.score).toBeNull();
  expect(page.rank.number).toBeNull();
  expect((await iceBoard(world)).find((task) => task.id === made.id)?.rank).toStrictEqual(
    page.rank,
  );
});

it.each([0, 11, 2.5, '7'])(
  'invalid ICE mark %s is refused without changing marks or revision',
  async (impact) => {
    const made = await newIceTask(world);
    const before = await icePage(world, made.id);
    expect(
      await iceCommand(world, {
        command: 'task.set_scores',
        recordId: made.id,
        expectedRevision: before.revision,
        fields: { impact, confidence: 9, ease: 8 },
      }),
    ).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
    const after = await icePage(world, made.id);
    expect(after.revision).toBe(before.revision);
    expect(after).toHaveProperty('scores', { impact: null, confidence: null, ease: null });
  },
);

it('stale and missing write authority cannot replace stored marks or grant access by choosing them', async () => {
  const made = await newIceTask(world);
  const marked = handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { impact: 7, confidence: 9, ease: 8 },
    }),
  );
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, world.reader, 'read', { kind: 'record', id: made.id });
  });
  const body = {
    command: 'task.set_scores',
    recordId: made.id,
    expectedRevision: marked.revision,
    fields: { impact: 10, confidence: 10, ease: 10 },
  } satisfies UncheckedRequest;
  expect(await iceCommand(world, body, world.reader)).toMatchObject({
    refused: true,
    code: 'SCOPE_NOT_GRANTED',
  });
  expect(await iceCommand(world, { ...body, expectedRevision: made.revision })).toMatchObject({
    refused: true,
    code: 'VERSION_STALE',
  });
  const page = await icePage(world, made.id, world.reader);
  expect(page.revision).toBe(marked.revision);
  expect(page).toHaveProperty('scores', { impact: 7, confidence: 9, ease: 8 });
});

it('the score command requires the actual read revision and cannot accept an unversioned write', async () => {
  const made = await newIceTask(world);
  expect(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: made.id,
      fields: { impact: 7, confidence: 9, ease: 8 },
    }),
  ).toMatchObject({
    refused: true,
    code: 'EXPECTED_REVISION_REQUIRED',
  });
  const page = await icePage(world, made.id);
  expect(page.revision).toBe(made.revision);
  expect(page).toHaveProperty('scores', { impact: null, confidence: null, ease: null });
});

async function clientTask(index: number) {
  const made = await newIceTask(world);
  const onClient = handle(
    await iceCommand(world, {
      command: 'task.set_party',
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { client: world.clients[index] },
    }),
  );
  return handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: made.id,
      expectedRevision: onClient.revision,
      fields: { impact: 6, confidence: 8, ease: 9 },
    }),
  );
}
async function foreignTask() {
  const owner = await enrol(world.db.app, world.foreign, 'ice-foreign-owner');
  await world.db.app.withBusiness(world.foreign, async (tx) => {
    await grantTo(tx, owner, 'write');
  });
  return handle(
    await executeCommand(world.db.app, world.foreign, owner.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'ICE OTHER BUSINESS CANARY' },
    }),
  );
}

it('raw marks stay inside granted internal reads and never enter external, ungranted, other-client or other-business responses', async () => {
  const own = await clientTask(0);
  const hidden = await clientTask(1);
  const foreign = await foreignTask();
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, world.reader, 'read', { kind: 'record', id: own.id });
  });
  expect(await icePage(world, own.id, world.reader)).toHaveProperty('scores', {
    impact: 6,
    confidence: 8,
    ease: 9,
  });
  const read = (by: typeof world.reader, id: string) =>
    executeRead(world.db.app, world.business, by.presented, { read: 'task.read', recordId: id });
  const denied = [
    await read(world.reader, hidden.id),
    await read(world.nobody, own.id),
    await read(world.owner, foreign.id),
  ];
  expect(denied).toMatchObject([
    { refused: true, code: 'SCOPE_NOT_GRANTED' },
    { refused: true, code: 'SCOPE_NOT_GRANTED' },
    { refused: true, code: 'NOT_FOUND' },
  ]);
  expect(JSON.stringify(denied)).not.toMatch(/"scores"|ICE OTHER BUSINESS CANARY/u);
  const outsider = await shareWithClient(world.db.app, world.business, world.owner, own.id);
  const shared = await read(outsider, own.id);
  expect(shared).toHaveProperty('sharedTask');
  expect(JSON.stringify(shared)).not.toMatch(/"scores"|"impact"|"confidence"|"ease"/u);
  expect(
    await iceCommand(
      world,
      {
        command: 'task.set_scores',
        recordId: own.id,
        expectedRevision: own.revision,
        fields: { impact: 10 },
      },
      outsider,
    ),
  ).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
});

it('an actual delegated agent retains its accepted rank read but receives no new raw mark projection', async () => {
  const w = await agentWorld('orch172_ice_agent', `ice-agent-${randomUUID().slice(0, 8)}`);
  try {
    const person = await w.decider('ice-agent-owner');
    const picked = await w.pickUp(person, 'Synthetic delegated ICE');
    const page = await executeRead(w.db.app, w.business, person.presented, {
      read: 'task.read',
      recordId: picked.taskId,
    });
    if (isCommandRefusal(page) || !('task' in page))
      throw new Error('Agent fixture person task read refused');
    handle(
      await w.asPerson(person, {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: page.task.revision,
        fields: { impact: 7, confidence: 9, ease: 8 },
      }),
    );
    const own = await w.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    expect(own).toMatchObject({ detail: { task: { rank: { calc: expect.any(String) } } } });
    expect(JSON.stringify(own)).not.toContain('"scores"');
  } finally {
    await w.drop();
  }
});
