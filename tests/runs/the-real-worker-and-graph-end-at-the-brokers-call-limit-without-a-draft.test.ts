// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2098-4 on #2098, copied unchanged but for its name: TEST F2
// through the real graph and worker reaches the broker's call limit.
import { expect, it, vi } from 'vitest';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { AGENT_MODEL_CALL_LIMIT } from '../../packages/core-wire/src/index.ts';
import { agentBroker, replied } from './agent-draft-world.ts';
import { acceptedPlan } from './compute-seam-world.ts';
import { named, noDatabase, outcomesOf, shapeOf, useStopWorld, world } from './run-stop-world.ts';

// Observe the real graph's thrown error without changing its invocation or result.
const graphErrors = vi.hoisted(() => [] as { name: string; message: string }[]);
vi.mock('langchain', async (load) => {
  const real = await load<typeof import('langchain')>();
  return {
    ...real,
    createAgent: (...args: Parameters<typeof real.createAgent>) => {
      const graph = real.createAgent(...args);
      const invoke = graph.invoke.bind(graph);
      graph.invoke = async (...input: Parameters<typeof graph.invoke>) => {
        try {
          return await invoke(...input);
        } catch (error) {
          graphErrors.push({ name: (error as Error).name, message: (error as Error).message });
          throw error;
        }
      };
      return graph;
    },
  };
});

useStopWorld('realgraphlimit');
it.skipIf(noDatabase)(
  "the real worker and graph end at the broker's call limit without a draft",
  async () => {
    const seam = await acceptedPlan(
      'the real graph reaches the broker limit',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
    );
    world.provider.script(
      Array.from({ length: AGENT_MODEL_CALL_LIMIT }, (_, index) =>
        replied('Read again.', [
          { id: `read_${index}`, name: 'task.read', args: { taskId: seam.taskId } },
        ]),
      ),
    );
    const before = world.provider.seen.length;
    const ended = await seam.worker.applyOnce(seam.taskId);
    expect(
      ended,
      JSON.stringify({
        graphErrors,
        providerTurns: world.provider.seen.length - before,
        turns: seam.log
          .filter((sent) => sent.verb === 'model.call')
          .map((sent) => ({
            status: sent.status,
            turnOrdinal: sent.body['turnOrdinal'],
            terminal: sent.detail['terminal'],
          })),
      }),
    ).toEqual({
      ended: { taskId: seam.taskId, outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' },
    });
    expect(world.provider.seen.length - before).toBe(AGENT_MODEL_CALL_LIMIT);
    expect(shapeOf(await outcomesOf(seam.work()))).toEqual([
      named('call_limit', 'CALL_LIMIT_REACHED'),
    ]);
    expect(seam.log.filter((sent) => sent.verb === 'task.handback')).toEqual([]);
    expect(seam.log.filter((sent) => sent.verb === 'task.comment')).toEqual([]);
  },
  120_000,
);
