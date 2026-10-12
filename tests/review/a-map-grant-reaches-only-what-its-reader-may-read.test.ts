// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('sol1364', 'sol1364');
  owner = await w.decider('Sol owner');
}, 180_000);
afterAll(async () => await w?.drop());

it('pending gates leave out a ticket gate the map decider cannot decide', async () => {
  const map = await w.create(owner, { title: 'Decision map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Decision ticket' }, { parentId: map.id });
  must(
    await w.as(owner, {
      command: 'task.propose',
      recordId: ticket.id,
      expectedRevision: await w.revisionOf(ticket.id),
      purpose: 'sol_pending',
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
    'propose ticket',
  );
  const [gate] = await w.db.admin.execute<{ readonly id: string; readonly version_id: string }>(
    `select g.id, g.version_id from public.gates g
     join public.planned_runs pr on pr.business_id = g.business_id and pr.id = g.run_id
     where g.business_id = $1 and pr.task_id = $2`,
    [w.business, ticket.id],
  );
  if (gate === undefined) throw new Error('proposal created no gate');
  const decider = await w.member('Sol map decider', ['decide'], { kind: 'record', id: map.id });
  expect(
    codeOf(
      await w.as(decider, {
        command: 'task.decide',
        gateId: gate.id,
        versionId: gate.version_id,
        decision: 'reject',
        note: 'Sol admission control',
      }),
    ),
  ).toBe('SCOPE_NOT_GRANTED');
  const answer = await executeRead(w.db.app, w.business, decider.presented, {
    read: 'gate.pending',
  });
  if (!('awaiting' in answer)) throw new Error('pending read was refused');
  expect(answer.awaiting.map((item) => item.gateId)).not.toContain(gate.id);
});

it('a map reader ranks a ticket within the whole granted map pool', async () => {
  const map = await w.create(owner, { title: 'Rank map' }, { taskType: 'map' });
  const otherMap = await w.create(owner, { title: 'Other rank map' }, { taskType: 'map' });
  const low = await w.create(owner, { title: 'Low rank ticket' }, { parentId: map.id });
  const high = await w.create(owner, { title: 'High rank ticket' }, { parentId: map.id });
  const hidden = await w.create(
    owner,
    { title: 'Hidden highest ticket' },
    { parentId: otherMap.id },
  );
  for (const [recordId, mark] of [
    [low.id, 1],
    [high.id, 2],
    [hidden.id, 10],
  ] as const) {
    must(
      // oxlint-disable-next-line no-await-in-loop -- each score reads the revision the last one wrote
      await w.as(owner, {
        command: 'task.set_scores',
        recordId,
        // oxlint-disable-next-line no-await-in-loop -- as above
        expectedRevision: await w.revisionOf(recordId),
        fields: { impact: mark, confidence: mark, ease: mark },
      }),
      'set scores',
    );
  }
  const reader = await w.member('Sol rank map reader', ['read'], { kind: 'record', id: map.id });
  const answer = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'task.read',
    recordId: low.id,
  });
  if (!('task' in answer) || !('rank' in answer.task)) throw new Error('rank detail was refused');
  expect(answer.task.rank.number).toBe(2);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: hidden.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
});

it('a map read lists every ticket its reader may read one by one', async () => {
  const map = await w.create(owner, { title: 'Sol map' }, { taskType: 'map' });
  const first = await w.create(owner, { title: 'First ticket' }, { parentId: map.id });
  const second = await w.create(owner, { title: 'Second ticket' }, { parentId: map.id });
  const nested = await w.create(
    owner,
    { title: 'Nested map' },
    { taskType: 'map', parentId: map.id },
  );
  const reader = await w.member('Sol map reader', ['read'], { kind: 'record', id: map.id });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: first.id }))).toBe('applied');
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: second.id }))).toBe('applied');
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: nested.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  const answer = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'task.read',
    recordId: map.id,
  });
  if (!('task' in answer) || !('steps' in answer.task)) throw new Error('map detail was refused');
  expect(answer.task.steps.map((step) => step.id).toSorted()).toEqual(
    [first.id, second.id].toSorted(),
  );
});

// eslint-disable-next-line max-lines-per-function -- a proof kept as its reviewer wrote it
it('a board reads no ticket content written after the ticket moves out of its granted map', async () => {
  const mapA = await w.create(owner, { title: 'Granted map' }, { taskType: 'map' });
  const mapB = await w.create(owner, { title: 'Ungranted map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Before transfer' }, { parentId: mapA.id });
  const reader = await w.member('Sol transfer reader', ['read'], { kind: 'record', id: mapA.id });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');
  const canary = 'SOL-1364-PRIVATE-CONTENT-WRITTEN-AFTER-TRANSFER';
  let moved = false;
  const received: string[] = [];
  const app = w.db.app;
  const observed: Database = {
    log: app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            if (
              !moved &&
              statement.includes('select distinct e.scope_kind, e.scope_id') &&
              parameters?.[0] === 'task' &&
              parameters[1] === 'read'
            ) {
              moved = true;
              must(
                await w.asOnSecond(owner, {
                  command: 'task.reparent',
                  recordId: ticket.id,
                  expectedRevision: await w.revisionOf(ticket.id),
                  parentId: mapB.id,
                }),
                'transfer ticket',
              );
              must(
                await w.asOnSecond(owner, {
                  command: 'task.update',
                  recordId: ticket.id,
                  expectedRevision: await w.revisionOf(ticket.id),
                  fields: { title: canary },
                }),
                'write private content after transfer',
              );
            }
            return rows;
          },
        };
        return await run(watched);
      }),
  };
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(
    moved,
    'the transfer must commit between scope expansion and board content retrieval',
  ).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect('tasks' in answer, 'the board read must complete').toBe(true);
  expect({
    privateContentFetched: received.join('\n').includes(canary),
    privateContentReturned: JSON.stringify(answer).includes(canary),
  }).toEqual({ privateContentFetched: false, privateContentReturned: false });
}, 60_000);
