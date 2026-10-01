// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 on the execution graph: work handed to a helper through the runtime's
// hand-over (`delegateChild`), the helper's calls through the real executor,
// and the person's `task.execution` read of the parent's run.

import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import type { Delegation } from '../../packages/core-records/src/authority/delegations.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { childRequest, parentWork, type Helper } from '../runtime/aw-11-child-world.ts';
import { delegateOn } from '../runtime/aw-11-child-work-world.ts';
import type { Schedules, Work } from '../runtime/schedules-harness.ts';

export interface Handed {
  readonly work: Work;
  readonly parent: Delegation;
  readonly parentCredential: string;
  readonly childId: string;
  readonly childCredential: string;
}

/** Picked-up work handed to `helper` over the parent's own lease; the child reads and writes tasks. */
export async function handedWork(
  on: Schedules,
  helper: Helper,
  title = `aw-11 graph ${randomUUID()}`,
  maximumMinor = 2_000,
): Promise<Handed> {
  const { work, parent, credential } = await parentWork(on, title, maximumMinor);
  const handed = await handOver(on, parent, work, helper);
  return { work, parent, parentCredential: credential, ...handed };
}

/** `delegateChild` for `helper` on `work`'s lease, or a throw naming the refusal. */
export async function handOver(
  on: Schedules,
  parent: Delegation,
  work: Work,
  helper: Helper,
): Promise<{ readonly childId: string; readonly childCredential: string }> {
  const handed = await delegateOn(
    on,
    parent,
    work,
    childRequest(helper, { collections: ['task'], actions: ['read', 'write'] }),
  );
  if (!handed.ok) throw new Error(`the helper was not handed the work: ${handed.refusal.code}`);
  return { childId: handed.value.childDelegationId, childCredential: handed.value.credential };
}

/** `task.execution` as `who` reads it: the answer, or the refusal body. */
export async function executionAs(
  on: Schedules,
  who: VerifiedSubject,
  taskId: string,
): Promise<Record<string, unknown>> {
  return (await executeRead(on.db.app, on.business, who, {
    read: 'task.execution',
    recordId: taskId,
  } as never)) as unknown as Record<string, unknown>;
}

export interface HelperEntry {
  readonly childDelegationId: string;
  readonly helperActorId: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly refusal: string | null;
  readonly fault: string | null;
  readonly spentMinor: number | null;
  readonly steps: readonly {
    readonly callId: string;
    readonly operation: string;
    readonly state: string;
    readonly reservedMinor: number;
    readonly spentMinor: number | null;
  }[];
}

export interface Node {
  readonly nodeId: string;
  readonly observed: Record<string, unknown>;
  readonly helpers?: readonly HelperEntry[];
}

/** The run's node on the task's graph, as the business's decider reads it. */
export async function nodeOf(on: Schedules, work: Work): Promise<Node | undefined> {
  const read = await executionAs(on, on.decider.presented, work.taskId);
  const graph = (read as { execution?: { graph?: { nodes: readonly Node[] } } }).execution?.graph;
  return graph?.nodes.find((node) => node.nodeId === work.picked['runId']);
}
