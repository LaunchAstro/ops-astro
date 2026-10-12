// SPDX-License-Identifier: AGPL-3.0-only
//
// The end of a budget-stopped run is refused while its stopped step's cost is
// unknown (`observedRefusal`). The refusal reads, under the end's task lock,
// whether the task is in the trash, and names the restore first when it is,
// since a person's outcome does not reach a trashed task. A trash or a restore
// of the task meets the end on a connection of its own, each seen waiting
// behind a third holding the task row, in either order. The refusal's words
// follow the task as it stands after the end's lock wait, and the refusal
// writes nothing.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { appliedDetail, codeOf, revisionOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { people, usePeople } from './budget-answers-world.ts';
import { stateOf } from './observed-hold-world.ts';
import { as, queued, waitingUnknown, type Racer, type Waiting } from './budget-stop-race-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endtrashrace');
usePeople();

const endOn = (at: Waiting) => async (database: Database) =>
  await as(database, people.second, {
    command: 'run.end_at_budget_stop',
    operationId: randomUUID(),
    recordId: at.w.taskId,
    runId: at.runId,
    askId: at.askId,
  });

const trashOn = (at: Waiting, revision: number) => async (database: Database) =>
  await as(database, s.decider, {
    command: 'task.trash',
    operationId: randomUUID(),
    recordId: at.w.taskId,
    expectedRevision: revision,
  });

const restoreOf = (batchId: unknown) => async (database: Database) =>
  await as(database, s.decider, { command: 'task.restore', operationId: randomUUID(), batchId });

/** `first` then `second`, queued in that order behind a third connection holding the task row. */
const raced = async (at: Waiting, first: Racer, second: Racer) =>
  await queued({ table: 'records', id: at.w.taskId }, first, second);

/** The refusal's fixes, joined; throws when `result` applied. */
function fixesOf(result: CommandResult | undefined): string {
  if (result === undefined || !isCommandRefusal(result)) throw new Error('the end applied');
  expect(result.code).toBe('TRANSITION_NOT_PERMITTED');
  return result.fixes.join(' ');
}

const RESTORE = 'Restore the task from the trash';
const RECORD = 'Record the step’s outcome first';

it('a trash that commits while the end waits on the task: the refusal names the restore and writes nothing', async () => {
  const at = await waitingUnknown(false);
  const before = await stateOf(at.runId, at.w.attemptId);
  const [trashed, ended] = await raced(
    at,
    trashOn(at, await revisionOf(s, at.w.taskId)),
    endOn(at),
  );
  expect(codeOf(trashed as CommandResult)).toBe('applied');
  expect(fixesOf(ended)).toContain(RESTORE);
  expect(await stateOf(at.runId, at.w.attemptId)).toEqual(before);
});

it('an end ahead of a trash: the refusal names the outcome only, and the trash then applies', async () => {
  const at = await waitingUnknown(false);
  const before = await stateOf(at.runId, at.w.attemptId);
  const [ended, trashed] = await raced(
    at,
    endOn(at),
    trashOn(at, await revisionOf(s, at.w.taskId)),
  );
  expect(fixesOf(ended)).toContain(RECORD);
  expect(fixesOf(ended)).not.toContain(RESTORE);
  expect(codeOf(trashed as CommandResult)).toBe('applied');
  expect(await stateOf(at.runId, at.w.attemptId)).toEqual(before);
});

it('a restore that commits while the end waits on the task: the refusal names the outcome only', async () => {
  const at = await waitingUnknown(false);
  const trash = appliedDetail(
    await trashOn(at, await revisionOf(s, at.w.taskId))(s.db.app),
    'task.trash',
  );
  const before = await stateOf(at.runId, at.w.attemptId);
  const [restored, ended] = await raced(at, restoreOf(trash['batchId']), endOn(at));
  expect(codeOf(restored as CommandResult)).toBe('applied');
  expect(fixesOf(ended)).toContain(RECORD);
  expect(fixesOf(ended)).not.toContain(RESTORE);
  expect(await stateOf(at.runId, at.w.attemptId)).toEqual(before);
});
