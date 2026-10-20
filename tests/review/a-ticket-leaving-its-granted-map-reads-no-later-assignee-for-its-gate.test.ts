// SPDX-License-Identifier: AGPL-3.0-only
// A reader whose only task read is a record grant on map M, and who holds
// decide on ticket T, reads the board while T waits at a gate. Once the board
// has read T's gate for the reader's own decision, a second connection takes
// T out of M and gives it a new assignee, and commits. The four-eyes question
// that follows must not read that new assignee: T is no longer readable, and
// each statement judges the grant inside itself.
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
// The open-gates statement (`openGates` in reads/awaiting.ts). The board sends
// it twice: for the rows waiting at a gate, then for the reader's own decision.
const OPEN_GATES = 'is not null as escalated';

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('p10assignee', 'p10assignee');
  owner = await w.decider('Gate assignee owner');
  await w.grant(owner, 'assign');
}, 180_000);
afterAll(async () => await w?.drop());

function observedDatabase(
  after: (statement: string, rows: readonly unknown[]) => Promise<void>,
): Database {
  return {
    log: w.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await w.db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            await after(statement, rows);
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

const assign = async (onSecond: boolean, recordId: string, personId: string) => {
  const body = {
    command: 'task.assign',
    recordId,
    expectedRevision: await w.revisionOf(recordId),
    fields: { assignee: personId },
  };
  must(onSecond ? await w.asOnSecond(owner, body) : await w.as(owner, body), 'assign');
};

// eslint-disable-next-line max-lines-per-function -- one race, its schedule read top to bottom
it('a ticket moved out of its granted map after its gate is read has no later assignee read for the reader’s decision', async () => {
  const map = await w.create(owner, { title: 'Decided map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Gated ticket' }, { parentId: map.id });
  const reader = await w.member('Map decider', ['read'], { kind: 'record', id: map.id });
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, reader, 'decide', { kind: 'record', id: ticket.id });
  });
  const later = await w.member('Later assignee', [], { kind: 'record', id: map.id });
  await assign(false, ticket.id, reader.personId);
  must(
    await w.as(owner, {
      command: 'task.propose',
      recordId: ticket.id,
      expectedRevision: await w.revisionOf(ticket.id),
      purpose: 'decided_map',
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
    'propose a gate',
  );
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');

  let gateReads = 0;
  let left = false;
  const received: string[] = [];
  const observed = observedDatabase(async (statement, rows) => {
    received.push(JSON.stringify(rows));
    if (!statement.includes(OPEN_GATES)) return;
    gateReads += 1;
    // The second gate read is the reader's own decision's, judged while T is readable.
    if (gateReads !== 2 || !JSON.stringify(rows).includes(ticket.id)) return;
    left = true;
    must(
      await w.asOnSecond(owner, {
        command: 'task.reparent',
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        parentId: null,
      }),
      'move the ticket out of its map',
    );
    await assign(true, ticket.id, later.personId);
  });
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(left).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  if (!('tasks' in answer)) throw new Error(`task.board refused: ${JSON.stringify(answer)}`);
  const served = (
    answer.tasks as unknown as readonly {
      readonly id: string;
      readonly awaitingDecision: boolean;
    }[]
  ).find((row) => row.id === ticket.id);
  expect({
    laterAssigneeFetched: received.join('\n').includes(later.personId),
    awaitingDecision: served?.awaitingDecision,
  }).toEqual({ laterAssigneeFetched: false, awaitingDecision: false });
}, 60_000);
