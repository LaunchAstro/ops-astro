// SPDX-License-Identifier: AGPL-3.0-only
//
// A field command is in a task's history only when it changed a field its
// reader is told of. A repeat of the stored value changed nothing, and a rank
// mark edit is nothing an agent is told of, by its history or by a lookup. An
// act such as a cancel is its own change with no field written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, detailOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { made } from '../commands/field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';
import type { FieldChanges } from '../../packages/core-commands/src/commands/outcome.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

let world: AgentWorld;
let mia: Decider;

const historyOf = async (recordId: string): Promise<readonly HistoryEntry[]> => {
  const answer = await executeRead(world.db.app, world.business, mia.presented, {
    read: 'task.read',
    recordId,
  } as never);
  if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
  return answer.task.history;
};

/** An applied event written as the envelope writes one, with the field names given or none. */
const recorded = async (
  recordId: string,
  fieldChanges: FieldChanges | null,
  command = 'task.update',
) =>
  await world.db.app.withBusiness(world.business, async (tx) => {
    const written = await writeAuditEvent(tx, {
      actorId: mia.actorId,
      command,
      operationId: randomUUID(),
      outcome: 'applied',
      subjectRecordId: recordId,
      payloadDigest: '0'.repeat(64),
      fieldChanges,
    });
    return written.id;
  });

// eslint-disable-next-line max-lines-per-function -- one world, the history cases on it in order
describe.skipIf(!configured)('history lists a field command only for a change shown', () => {
  beforeAll(async () => {
    world = await agentWorld('history_shown', 'history-shown');
    mia = await world.decider('Mia');
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  it('an agent is not told a rank mark changed, by history or by lookup', async () => {
    const picked = await world.pickUp(mia, 'ranked behind the agent’s back');
    const revision = await world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [picked.taskId],
    );
    const scores = await world.asPerson(mia, {
      command: 'task.set_scores',
      operationId: randomUUID(),
      recordId: picked.taskId,
      expectedRevision: Number(revision[0]?.revision),
      fields: { impact: 9 },
    });
    expect(isCommandRefusal(scores)).toBe(false);
    const rankOnly = await recorded(picked.taskId, { version: 1, keys: ['impact'] });
    // Recorded before a rank-mark command named its keys.
    const legacy = await recorded(picked.taskId, null, 'task.set_scores');
    const staff = await historyOf(picked.taskId);
    const scored = staff.find((one) => one.operation === 'task.set_scores');
    expect(scored?.changed).toStrictEqual(['impact']);
    expect(staff.find((one) => one.eventId === rankOnly)?.changed).toStrictEqual(['impact']);
    expect(staff.find((one) => one.eventId === legacy)?.operation).toBe('task.set_scores');
    for (const id of [scored?.eventId ?? '', rankOnly, legacy]) {
      const body = {
        command: 'task.read',
        operationId: randomUUID(),
        recordId: picked.taskId,
        historyEventId: id,
      };
      // oxlint-disable-next-line no-await-in-loop
      const answer = await world.asAgent(body, picked.credential);
      const own = detailOf(answer)['task'] as {
        readonly history: readonly HistoryEntry[];
        readonly historyEvent?: unknown;
      };
      expect(own.history.map((one) => one.eventId)).not.toContain(id);
      expect(own.history.map((one) => one.operation)).not.toContain('task.set_scores');
      expect(own.historyEvent).toBeNull();
    }
  });

  it('a field command that changed nothing is not a change; a cancel still is', async () => {
    const task = made(
      await world.asPerson(mia, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'assigned twice' },
      }),
    );
    const before = await historyOf(task.recordId);
    for (const command of ['task.assign', 'task.set_stage', 'task.set_category']) {
      // oxlint-disable-next-line no-await-in-loop
      await recorded(task.recordId, { version: 1, keys: [] }, command);
    }
    expect(await historyOf(task.recordId)).toStrictEqual(before);
    const cancel = await recorded(task.recordId, { version: 1, keys: [] }, 'task.cancel');
    expect((await historyOf(task.recordId)).at(-1)).toMatchObject({
      eventId: cancel,
      operation: 'task.cancel',
    });
  });
});
