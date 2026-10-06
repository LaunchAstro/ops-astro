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
  /** The proposal pass under way: a second pass shares it, never starting its own. */
  running?: Promise<Proposed> | undefined;
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

/** `step` proposed once on the delegation's task, one pass at a time per worker. */
export async function proposeStep(
  call: Call,
  mine: Proposer,
  step: { readonly kind: string },
  reporter: Pick<UsageReporter, 'estimate'>,
): Promise<Proposed> {
  mine.running ??= proposeAlone(call, mine, step, reporter).finally(() => {
    mine.running = undefined;
  });
  return await mine.running;
}

/**
 * Whether the task shows the proposal `operationId` names: its payload
 * carries that id, so the server's own read tells a committed proposal from
 * one that never ran. A replay refused by a delegation check
 * (`agent-replay.ts`) may be withholding a committed receipt; it is kept
 * unless this read answers and shows no such proposal.
 */
async function committed(call: Call, recordId: string, operationId: string): Promise<boolean> {
  const read = await call('task.read', { recordId });
  if (!('body' in read)) return true;
  const task = read.detail['task'] as { proposals?: readonly LineageSeen[] } | undefined;
  return (task?.proposals ?? []).some((lineage) =>
    (lineage.versions ?? []).some((one) => one.payload?.proposalId === operationId),
  );
}

interface LineageSeen {
  readonly versions?: readonly { readonly payload?: { readonly proposalId?: unknown } }[];
}

/** A proposal with no answer, or one whose refusal proves nothing, is sent again as it was. */
async function proposeAlone(
  call: Call,
  mine: Proposer,
  step: { readonly kind: string },
  reporter: Pick<UsageReporter, 'estimate'>,
): Promise<Proposed> {
  const capabilities = await call('session.capabilities', {});
  if (!('body' in capabilities)) return capabilities;
  mine.actorId = String(capabilities.body['agentActorId']);
  if (mine.unanswered === undefined) {
    const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
    const recordId = String(scope?.id ?? '');
    const read = await call('task.read', { recordId });
    if (!('body' in read)) return read;
    const task = read.detail['task'] as { revision?: unknown } | undefined;
    const operationId = randomUUID();
    mine.unanswered = {
      operationId,
      recordId,
      expectedRevision: task?.revision,
      purpose: step.kind,
      maximumMinor: reporter.estimate(step),
      currency: 'AUD',
      payload: {
        change: 'a team-only comment; this demonstration changes nothing outside the app',
        proposalId: operationId,
      },
      step,
    };
  }
  const sent = mine.unanswered;
  const proposed = await call('task.propose', sent);
  if ('fault' in proposed) return proposed;
  const withheld = 'refused' in proposed && proposed.refused.code.startsWith('DELEGATION_');
  if (withheld && (await committed(call, sent.recordId, String(sent['operationId'])))) {
    return proposed;
  }
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
