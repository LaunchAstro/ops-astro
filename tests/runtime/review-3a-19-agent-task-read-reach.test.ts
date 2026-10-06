// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-19: the AW-01 isolation suite's "another person under a live
// delegation" case checks reach through `task.execution`, which no agent may
// call on any task (`DELEGATION_EXCLUDES_OPERATION` before any delegation
// check), so it passes whatever the agent's `task.read` reaches. This case
// asks the operation an agent does hold, `task.read`, on the task an
// occurrence run landed on: it must be refused under the one-task ceiling
// while the agent's own task still reads.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { asAgent, codeOf as commandCode } from './schedules-harness.ts';
import {
  authorityFor,
  noDatabase,
  occurrence,
  start,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('rv3a19');

it('REVIEW-3A-19: an agent under a live delegation cannot task.read the task an occurrence run landed on', async () => {
  const started = await start(w.s, await occurrence(w.s), authorityFor(w.s), w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  const credential = String(w.work.picked['credential']);
  const readAsAgent = async (recordId: string) =>
    await asAgent(w.s, { command: 'task.read', operationId: randomUUID(), recordId }, credential);

  // The delegation is live and task.read is within it: its own task reads.
  expect(commandCode(await readAsAgent(w.work.taskId))).toBe('applied');

  // The occurrence run's task is really there and outside the purpose.
  const crossed = await readAsAgent(started.value.taskId);
  expect(isCommandRefusal(crossed) ? crossed.code : 'applied').toBe('DELEGATION_OUT_OF_PURPOSE');
  const wire = JSON.stringify(crossed);
  expect(wire).not.toContain(started.value.runId);
  expect(wire).not.toContain('nightly reconciliation');
});
