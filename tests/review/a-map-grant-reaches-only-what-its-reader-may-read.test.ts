// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
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
