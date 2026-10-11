// SPDX-License-Identifier: AGPL-3.0-only
// Criterion 1: inclusion must use the keys the history projection actually sends.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentWorld,
  detailOf,
  type AgentWorld,
  type Decider,
  type PickedUp,
} from '../commands/agent-fixture.ts';
import { eventsOf, taskRow, update } from '../commands/field-changes-world.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

let world: AgentWorld;
let staff: Decider;

/** The task as the agent reads it, with one history entry looked up when given. */
async function readAsAgent(picked: PickedUp, historyEventId?: string) {
  const answer = await world.asAgent(
    {
      command: 'task.read',
      operationId: randomUUID(),
      recordId: picked.taskId,
      ...(historyEventId === undefined ? {} : { historyEventId }),
    },
    picked.credential,
  );
  expect(isCommandRefusal(answer)).toBe(false);
  const task = detailOf(answer)['task'];
  if (typeof task !== 'object' || task === null || !('history' in task)) {
    throw new Error('task history missing');
  }
  return task;
}

describe.skipIf(!configured)('a hidden field edit is not in an agent’s history', () => {
  beforeAll(async () => {
    world = await agentWorld('sol1214_fields', 'sol1214-fields');
    staff = await world.decider('proof-staff');
    const spine = await world.db.app.withBusiness(world.business, readTaskSpine);
    await world.db.admin.execute(
      `insert into public.field_defs
         (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
          visibility_class, searchable, unique_value, origin)
       values ($1, $2, $3, 'private_meta', 'Private meta', 'json', null, 'generic',
               'internal', false, false, 'preset')`,
      [world.business, randomUUID(), spine.taskTypeId],
    );
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  it('a custom-only update with no projected keys is omitted from history and lookup', async () => {
    const picked = await world.pickUp(staff, 'hidden fields proof');
    const read = async (historyEventId?: string) => await readAsAgent(picked, historyEventId);
    const before = await read();
    const row = await taskRow(world.db.admin, picked.taskId);
    const keys = ['private_meta'];
    const request = update(
      { recordId: picked.taskId, revision: Number(row['revision']) },
      { private_meta: { note: 'private change' } },
    );
    expect(await world.asPerson(staff, request)).toHaveProperty('detail.changed', keys);
    const events = await eventsOf(world.db.admin, [request.operationId]);
    expect(events).toHaveLength(1);
    expect(events[0]?.field_changes).toStrictEqual({ version: 1, keys });
    const eventId = events[0]?.row['id'];
    if (typeof eventId !== 'string') throw new Error('applied event missing');
    const after = await read(eventId);
    expect(after).not.toHaveProperty('scores');
    expect(after).not.toHaveProperty('private_meta');
    expect.soft(after.history).toStrictEqual(before.history);
    expect.soft(after).toHaveProperty('historyEvent', null);
  });
});
