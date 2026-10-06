// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b in the worker: the one versioned synthetic change it proposes on the
// task its delegation is for, and the agent identity it proposes as. A
// proposal sent with no answer may have committed, so it is kept and sent
// again under its own operation id, which replays it rather than opening a
// second lineage and gate. Like the rest of the worker, this only shapes
// calls to the API.

import { randomUUID } from 'node:crypto';
import type { Call, Unanswered } from './agent-call.ts';
import type { UsageReporter } from './usage.ts';

/** What one worker knows of its own proposing: who it is, and a proposal not yet answered. */
export interface Proposer {
  actorId?: string;
  unanswered?: { readonly recordId: string; readonly [field: string]: unknown } | undefined;
}

export type Proposed =
  | {
      readonly proposed: {
        readonly taskId: string;
        readonly version: number;
        readonly gateId: string;
      };
    }
  | Unanswered;

/** The agent's own acting identity, read from its capabilities once and kept. */
export async function selfOf(call: Call, mine: Proposer): Promise<string | Unanswered> {
  if (mine.actorId !== undefined) return mine.actorId;
  const capabilities = await call('session.capabilities', {});
  if (!('body' in capabilities)) return capabilities;
  mine.actorId = String(capabilities.body['agentActorId']);
  return mine.actorId;
}

/** `step` proposed once on the delegation's task; a proposal with no answer is sent again as it was. */
export async function proposeStep(
  call: Call,
  mine: Proposer,
  step: { readonly kind: string },
  reporter: Pick<UsageReporter, 'estimate'>,
): Promise<Proposed> {
  if (mine.unanswered === undefined) {
    const capabilities = await call('session.capabilities', {});
    if (!('body' in capabilities)) return capabilities;
    mine.actorId = String(capabilities.body['agentActorId']);
    const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
    const recordId = String(scope?.id ?? '');
    const read = await call('task.read', { recordId });
    if (!('body' in read)) return read;
    const task = read.detail['task'] as { revision?: unknown } | undefined;
    mine.unanswered = {
      operationId: randomUUID(),
      recordId,
      expectedRevision: task?.revision,
      purpose: step.kind,
      maximumMinor: reporter.estimate(step),
      currency: 'AUD',
      payload: {
        change: 'a team-only comment; this demonstration changes nothing outside the app',
      },
      step,
    };
  }
  const sent = mine.unanswered;
  const proposed = await call('task.propose', sent);
  if ('fault' in proposed) return proposed;
  mine.unanswered = undefined;
  if (!('body' in proposed)) return proposed;
  return {
    proposed: {
      taskId: sent.recordId,
      version: Number(proposed.detail['version']),
      gateId: String(proposed.detail['gateId']),
    },
  };
}
