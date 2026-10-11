// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115): `task.update` records the fields it actually changed, as names
// only, on its own applied audit event and in its answer's `changed`, for a
// person and for a delegated agent alike. The column takes nothing but that
// shape, on an applied event of a command that owns a task field.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { eventsOf, made, taskRow, update } from './field-changes-world.ts';

const configured = databaseUrlFromEnvironment() !== undefined;
const DUE = '2026-11-01T00:00:00.000Z';

// eslint-disable-next-line max-lines-per-function -- one world, the field cases on it
describe.skipIf(!configured)('P20 task.update records the fields it changed', () => {
  let world: AgentWorld;
  let writer: Decider;

  beforeAll(async () => {
    world = await agentWorld('p20_fields', 'p20-fields');
    writer = await world.decider('p20-writer');
  }, 90_000);
  afterAll(async () => {
    await world?.drop();
  });

  const create = async (fields: Readonly<Record<string, unknown>>) =>
    made(
      await world.asPerson(writer, { command: 'task.create', operationId: randomUUID(), fields }),
    );

  it.each([
    ['one field', { title: 'before' }, { title: 'after' }, ['title']],
    ['two fields', { title: 'before' }, { title: 'after', due: DUE }, ['due', 'title']],
    [
      'a field sent unchanged beside a change',
      { title: 'same' },
      { title: 'same', due: DUE },
      ['due'],
    ],
    ['nothing changed', { title: 'same', due: DUE }, { title: 'same', due: DUE }, []],
    ['a clear', { title: 'clear', due: DUE }, { due: null }, ['due']],
    ['a clear of nothing', { title: 'empty' }, { due: null }, []],
  ] as const)('%s', async (_case, initial, fields, keys) => {
    const request = update(await create(initial), fields);
    const answer = await world.asPerson(writer, request);
    expect(answer).toHaveProperty('detail.changed', keys);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(events.map((e) => [e.outcome, e.field_changes])).toStrictEqual([
      ['applied', { version: 1, keys }],
    ]);
  });

  it('keeps names only: no old or new value, and nothing of the request body', async () => {
    const task = await create({ title: 'P20 private old title' });
    const request = update(task, {
      title: 'P20 private new title',
      description: 'P20 private prose',
    });
    await world.asPerson(writer, request);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(events.map((e) => e.field_changes)).toStrictEqual([
      { version: 1, keys: ['description', 'title'] },
    ]);
    const stored = JSON.stringify(events);
    for (const value of ['P20 private old title', 'P20 private new title', 'P20 private prose']) {
      expect(stored).not.toContain(value);
    }
  });

  it('a refused update records no field names and changes nothing', async () => {
    const task = await create({ title: 'kept' });
    const before = await taskRow(world.db.admin, task.recordId);
    const request = update(task, { title: 'refused', state: 'done' });
    expect(await world.asPerson(writer, request)).toMatchObject({ refused: true });
    expect(await taskRow(world.db.admin, task.recordId)).toStrictEqual(before);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(events.map((e) => [e.outcome, e.field_changes])).toStrictEqual([['refused', null]]);
  });

  it("a delegated agent's update records its changes under the agent's actor", async () => {
    const picked = await world.pickUp(writer, 'same');
    const row = await taskRow(world.db.admin, picked.taskId);
    const request = update(
      { recordId: picked.taskId, revision: Number(row['revision']) },
      { title: 'same', due: DUE },
    );
    expect(await world.asAgent(request, picked.credential)).toHaveProperty('detail.changed', [
      'due',
    ]);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(events.map((e) => [e.outcome, e.field_changes, e.row['actor_id']])).toStrictEqual([
      ['applied', { version: 1, keys: ['due'] }, world.agentActorId],
    ]);
    expect(JSON.stringify(events)).not.toContain(picked.credential);
  });

  it.each([
    ['a value beside the names', { version: 1, keys: ['title'], values: ['x'] }, 'task.update'],
    ['an unknown version', { version: 2, keys: ['title'] }, 'task.update'],
    ['keys out of order', { version: 1, keys: ['title', 'due'] }, 'task.update'],
    ['a key twice', { version: 1, keys: ['due', 'due'] }, 'task.update'],
    ['a key outside the field grammar', { version: 1, keys: ['Title'] }, 'task.update'],
    ['a command that owns no task field', { version: 1, keys: [] }, 'task.comment'],
  ])('the column refuses %s', async (_case, changes, command) => {
    const actor = writer.actorId;
    await expect(
      world.db.admin.execute(
        `insert into public.audit_events
           (business_id, id, actor_id, command, operation_id, outcome, payload_digest,
            seq, hash, field_changes)
         values ($1, $2, $3, $4, $5, 'applied', $6, 1, $7, $8::jsonb)`,
        [
          world.business,
          randomUUID(),
          actor,
          command,
          randomUUID(),
          'a'.repeat(64),
          '0'.repeat(64),
          changes,
        ],
      ),
    ).rejects.toThrow(/audit_events_field_changes_supported/u);
  });

  it('the chain still verifies with the new events in it', async () => {
    expect(await world.db.app.withBusiness(world.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });
});
