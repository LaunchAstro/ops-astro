// SPDX-License-Identifier: AGPL-3.0-only
//
// What AW-09's database suites share: the agent's real output (an approved
// plan picked up and handed back with a successor, the reviewed output) and
// the agent's revisions on its lineage under a delegation the decider's grants
// narrow (`proposal:write`, inside the delegation).

import { randomUUID } from 'node:crypto';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import {
  asAgent,
  codeOf,
  freshPurpose,
  handbackBody,
  liveWork,
  proposeBody,
  revisionOf,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

export interface AgentOutput {
  readonly taskId: string;
  readonly lineageId: string;
  readonly gateId: string;
  readonly versionId: string;
  /** A live delegation for the agent's revisions on this task. */
  readonly delegation: string;
}

/** A delegation for the agent on `taskId`, narrowed from the decider's grants. */
export async function delegationOn(s: Schedules, taskId: string): Promise<string> {
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: s.agentActorId,
      delegatePersonId: s.decider.personId,
      mintedByActorId: s.decider.actorId,
      purpose: `aw09_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

export interface MadeOutput {
  readonly output: AgentOutput;
  readonly work: Work;
  readonly title: string;
}

/** The agent's handed-back output on a new task: the successor's pending gate. */
export async function agentOutput(
  s: Schedules,
  title = `aw-09 ${randomUUID()}`,
): Promise<MadeOutput> {
  const work = await liveWork(s, title, 2_000);
  const successor = {
    purpose: freshPurpose(),
    maximumMinor: 1_500,
    currency: 'AUD',
    payload: { instruction: 'the draft, for review' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  };
  const handedBack = await asAgent(
    s,
    handbackBody(work.picked, successor),
    String(work.picked['credential']),
  );
  if (codeOf(handedBack) !== 'applied') throw new Error(`handback ${codeOf(handedBack)}`);
  const detail = (handedBack as { detail: Detail }).detail;
  const output: AgentOutput = {
    taskId: work.taskId,
    lineageId: String(work.proposal['lineageId']),
    gateId: String(detail['successorGateId']),
    versionId: String(detail['successorVersionId']),
    delegation: await delegationOn(s, work.taskId),
  };
  return { output, work, title };
}

/** The agent proposes on the task: on `lineageId` (a revision), or on a new lineage. */
export async function agentProposes(
  s: Schedules,
  output: AgentOutput,
  options: { readonly lineageId?: string; readonly maximumMinor?: number } = {},
): ReturnType<typeof asAgent> {
  const body = proposeBody(output.taskId, await revisionOf(s, output.taskId), {
    maximumMinor: options.maximumMinor ?? 1_000,
    purpose: freshPurpose(),
    ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
  });
  return await asAgent(s, body, output.delegation);
}
