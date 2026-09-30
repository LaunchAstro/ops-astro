// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11's hand-over and handback as agent operations: `run.delegate_child`
// and `run.child_handback` through the production agent entry, in the child
// world's businesses.

import { randomUUID } from 'node:crypto';
import { asAgent, asPerson, type Body, type Schedules, type Work } from './schedules-harness.ts';
import type { Helper } from './aw-11-child-world.ts';

let purposes = 0;

/** `run.delegate_child`'s body on `work`'s own lease and fence, handing `helper` `task:read`. */
export function delegateBody(work: Work, helper: Helper, extra: Body = {}): Body {
  purposes += 1;
  return {
    command: 'run.delegate_child',
    operationId: randomUUID(),
    leaseId: work.picked['leaseId'],
    fence: work.picked['fence'],
    helperActorId: helper.actorId,
    purpose: `helper_cmd_${String(purposes)}`,
    collections: ['task'],
    actions: ['read'],
    expiresInSeconds: 600,
    ...extra,
  };
}

/** The parent's agent, presenting `credential`, asks for the hand-over. */
export async function delegateCall(
  on: Schedules,
  credential: string | undefined,
  body: Body,
): ReturnType<typeof asAgent> {
  return await asAgent(on, body, credential);
}

export function handbackBody(extra: Body = {}): Body {
  return {
    command: 'run.child_handback',
    operationId: randomUUID(),
    outcome: 'completed',
    ...extra,
  };
}

/** The helper, signed in as itself, presenting `credential`. */
export async function handbackCall(
  on: Schedules,
  helper: Helper,
  credential: string | undefined,
  body: Body,
): ReturnType<typeof asAgent> {
  return await asAgent({ ...on, agent: helper.presented }, body, credential);
}

export async function asPersonCall(on: Schedules, body: Body): ReturnType<typeof asPerson> {
  return await asPerson(on, body);
}
