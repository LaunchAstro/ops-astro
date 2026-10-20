// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan over the carried task world (#2091):
// the carried broker as the carried deployment with a plan route catalogues
// it, and the run's first turn carried as a task's call is.

import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/index.ts';
import type { Broker, ModelCallResult } from '../../packages/core-custody/src/index.ts';
import { revisionOf, type Work } from '../runtime/schedules-harness.ts';
import { requestFor, s } from './broker-world.ts';
import { carriedCall, type CarriedTaskWorld } from './carried-task-world.ts';

/**
 * The carried broker serving the agent's turn on the plan as the carried
 * deployment with a plan route catalogues it (#2091): its operation and adapter.
 */
export function turnBrokerOf(world: CarriedTaskWorld): Broker {
  const { operations, providers } = catalogueOf('ollama', false, true);
  return { ...world.broker, operations, providers };
}

/**
 * The run's first turn on the plan, the task at its revision now, offering
 * `tools` (none unless named), carried as `carriedCall` is.
 */
export async function carriedTurn(
  world: CarriedTaskWorld,
  work: Work,
  on: Broker = turnBrokerOf(world),
  tools: readonly string[] = [],
): Promise<ModelCallResult> {
  return await carriedCall(world, work, on, async () => {
    const task = { ref: 'task', taskId: work.taskId, revision: await revisionOf(s, work.taskId) };
    return requestFor(work, {
      operation: AGENT_TURN_KEY,
      fields: [],
      turn: { turnOrdinal: 0, tools, parts: [task] },
    });
  });
}
