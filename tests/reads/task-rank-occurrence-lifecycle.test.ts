// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  authorityFor,
  occurrence,
  start,
  useOccurrenceWorld,
  w,
} from '../runtime/occurrence-run-world.ts';
import { ownedRankServer } from './task-rank-core-world.ts';

ownedRankServer();
useOccurrenceWorld('p09_occurrence_lifecycle');
it('the existing occurrence writer creates a dateless unstarted task and exact occurrence replay preserves it', async () => {
  const occurrenceId = await occurrence(w.s);
  const authority = authorityFor(w.s);
  const first = await start(w.s, occurrenceId, authority, w.worker);
  if (!first.ok) throw new Error(`Occurrence refused ${first.refusal.code}`);
  const read = async () =>
    await executeRead(w.s.db.app, w.s.business, w.s.decider.presented, {
      read: 'task.read',
      recordId: first.value.taskId,
    });
  const before = await read();
  expect(before).toMatchObject({
    task: { startedAt: null, state: { machineCategory: 'unstarted' } },
  });
  const replay = await start(w.s, occurrenceId, authority, w.worker);
  expect(replay).toMatchObject({ ok: true, value: { taskId: first.value.taskId, replayed: true } });
  expect(await read()).toStrictEqual(before);
});
