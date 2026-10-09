// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { wayfinderWorld, must, type WayfinderWorld, type Decider } from '../wayfinder/world.ts';
import { ownedRankServer } from './task-rank-core-world.ts';

let world: WayfinderWorld;
let owner: Decider;
const firstStart = '2000-01-01T00:00:00.000Z';
beforeAll(async () => {
  ownedRankServer();
  world = await wayfinderWorld('p09_wayfinder', `p09-wayfinder-${randomUUID()}`);
  owner = await world.decider('lifecycle-owner');
}, 180_000);
afterAll(async () => {
  await world?.drop();
});

async function startedTicket() {
  const map = await world.create(owner, { title: 'Lifecycle map' }, { taskType: 'map' });
  const ticket = await world.create(
    owner,
    { title: 'Lifecycle research' },
    { taskType: 'research', parentId: map.id, stateKey: 'active' },
  );
  must(
    await world.as(owner, {
      command: 'task.update',
      recordId: ticket.id,
      expectedRevision: ticket.revision,
      fields: { started_at: firstStart },
    }),
    'correct first-start date',
  );
  must(
    await world.as(owner, {
      command: 'task.set_scores',
      recordId: ticket.id,
      expectedRevision: await world.revisionOf(ticket.id),
      fields: { impact: 7, confidence: 9, ease: 8 },
    }),
    'set marks',
  );
  expect(await world.read(owner, { read: 'task.read', recordId: ticket.id })).toMatchObject({
    task: { startedAt: firstStart, rank: { score: 756 } },
  });
  return ticket;
}

it.each(['task.resolve', 'task.close_out_of_scope'])(
  '%s retains first-start evidence and neutralises age until normal reopen',
  async (command) => {
    const ticket = await startedTicket();
    const operationId = randomUUID();
    const request = {
      command,
      operationId,
      recordId: ticket.id,
      expectedRevision: await world.revisionOf(ticket.id),
      ...(command === 'task.resolve'
        ? { answer: 'A recorded answer', gist: 'Research resolved' }
        : { reason: 'Outside the agreed work' }),
    };
    const first = await world.as(owner, request);
    must(first, command);
    expect(await world.as(owner, request)).toStrictEqual(first);
    expect(await world.read(owner, { read: 'task.read', recordId: ticket.id })).toMatchObject({
      task: { startedAt: firstStart, rank: { score: 504, number: null } },
    });
    must(
      await world.as(owner, {
        command: 'task.reopen',
        recordId: ticket.id,
        expectedRevision: await world.revisionOf(ticket.id),
        reason: 'Lifecycle reopen',
      }),
      'reopen',
    );
    expect(await world.read(owner, { read: 'task.read', recordId: ticket.id })).toMatchObject({
      task: { startedAt: firstStart, rank: { score: 756 } },
    });
    expect(
      (await world.audit()).filter(
        (row) => row.operationId === operationId && row.outcome === 'applied',
      ),
    ).toHaveLength(1);
  },
);
