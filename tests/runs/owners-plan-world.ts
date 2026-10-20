// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan as the carried deployment serves it (#2091, #2115): a
// broker made by `carriedBroker` from production-shaped settings with one
// plan route, over the carried task world, and a fresh task whose plan the
// owner proposed and accepted, so the run is his (#1620 P4).

import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { carrierSettings } from '../../apps/api/model-carrier.ts';
import { SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { CHATGPT_PLAN_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import type { ModelBroker } from '../../packages/core-commands/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  proposeBody,
  revisionOf,
} from '../runtime/schedules-harness.ts';
import type { CarriedTaskWorld } from '../broker/carried-task-world.ts';
import { s } from './run-stop-world.ts';

/** A carried deployment's settings as production sets them: Ollama on the M5 and the owner's plan. */
export const settingsOf = (carrierAgent: string): Record<string, string> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: carrierAgent, people: [s.decider.personId] }),
  MODEL_BROKER_ROUTES: JSON.stringify([
    {
      key: 'm5_ollama',
      reach: 'local',
      provider: 'ollama',
      credentialRef: 'carried',
      credentialKind: 'api_key',
      installation: 'here',
      ceiling: 4,
    },
    {
      key: 'chatgpt_plan',
      reach: 'cloud',
      provider: CHATGPT_PLAN_PROVIDER,
      credentialRef: 'carried',
      credentialKind: 'subscription',
      installation: 'here',
      ceiling: 1,
    },
  ]),
  MODEL_BROKER_INSTALLATION: 'here',
});

/** The carried deployment's broker for `settings`, over the world's custody. */
export function plansBroker(
  world: CarriedTaskWorld,
  settings: Record<string, string>,
): ModelBroker {
  const carried = carrierSettings(settings);
  if (carried.kind !== 'carried') throw new Error(`settings refused: ${JSON.stringify(carried)}`);
  return carriedBroker(carried, world.broker.custody);
}

/** The owner's own plan on the task: the worker's step, proposed and accepted by him. */
export async function ownersPlan(taskId: string): Promise<void> {
  const body = {
    ...proposeBody(taskId, await revisionOf(s, taskId), {
      purpose: SYNTHETIC_STEP.kind,
      maximumMinor: 8_500,
    }),
    step: SYNTHETIC_STEP,
  };
  await approve(s, appliedDetail(await asPerson(s, body), 'task.propose'));
}
