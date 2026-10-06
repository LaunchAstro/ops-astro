// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStories } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { asPerson, signed, unknownWork } from './c54-fixture.ts';

describe.skipIf(serverUrl === undefined)('OW-108 cancellation with outstanding liability', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld('sol_ow108_cancel');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  // Sol OW-108.2 criterion 1, retitled by what it proves; its body is Sol's.
  it('cancellation cannot override an unresolved unknown hold in the run story', async () => {
    const ada = signed(world.ada);
    const work = await unknownWork(world, ada);
    const read = async () => {
      const result = await asPerson(world, ada, 'task.read', { recordId: work.taskId });
      expect(result.status).toBe(200);
      return (result.body['task'] as { proposals: RunLineage[] }).proposals;
    };
    const before = await read();
    expect(runStories(before).at(-1)?.state).toBe('unknown-outcome');
    const cancelled = await asPerson(world, ada, 'task.cancel', {
      recordId: work.taskId,
      lineageId: before[0]?.lineageId,
      reason: 'Stop further work',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const after = await read();
    expect(after[0]?.state).toBe('cancelled');
    const story = runStories(after).at(-1);
    expect(story?.unknownAttempt?.id).toBe(work.attemptId);
    expect(story?.state).toBe('unknown-outcome');
    expect(story?.nextAction).toBe('A person checks what happened');
  });
});
