// SPDX-License-Identifier: AGPL-3.0-only
//
// What T3a's two database suites share: the request bodies, the revision
// ceiling, and one approved, applied and settled attempt over a real envelope.
// Split out of `t3a-revision-loop.test.ts` when its decide-authority cases
// moved to `t3a-decide-authority.test.ts`, each file under CQ-12's lines.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { EntryPoint } from '../../packages/core-records/src/tasks/placement.ts';
import {
  appliedDetail,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { PRICED, t2dHarness, type T2dHarness } from './t2d-harness.ts';

export const SURFACES: readonly EntryPoint[] = ['app', 'api', 'cli'];
export const noop = (): void => undefined;

/** A revision's ceiling: inside what the settled envelope has left (2500 held, 1800 spent). */
export const REVISION = 500;

export const decideBody = (version: Detail, decision: string): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the T3a loop`,
});

export const restartBody = (taskId: string, lineageId: unknown): Body => ({
  command: 'task.restart',
  operationId: randomUUID(),
  recordId: taskId,
  lineageId,
});

export const cancelBody = (taskId: string, lineageId: unknown): Body => ({
  command: 'task.cancel',
  operationId: randomUUID(),
  recordId: taskId,
  lineageId,
  reason: 'stopped in the T3a loop',
});

/** An envelope row of the task, as the suites compare it. */
export interface EnvelopeRow {
  readonly id: string;
  readonly state: string;
  readonly held: string;
  readonly actual: string;
}

export interface T3aHarness extends Pick<T2dHarness, 'work' | 'applied' | 'observeOf'> {
  envelopes(taskId: string): Promise<readonly EnvelopeRow[]>;
  settledWork(): Promise<{
    readonly w: Awaited<ReturnType<T2dHarness['work']>>;
    readonly envelopeId: string;
    readonly lineageId: string;
  }>;
}

/** The settled work both suites start from, over the schedules `get` returns. */
export function t3aHarness(get: () => Schedules): T3aHarness {
  const { work, applied, observeOf } = t2dHarness(get);

  async function envelopes(taskId: string): Promise<readonly EnvelopeRow[]> {
    const s = get();
    return await rows<EnvelopeRow>(
      s,
      `select id, state, held_minor::text as held, actual_minor::text as actual
         from public.task_envelopes where business_id = $1 and task_id = $2
        order by opened_at, id`,
      [s.business, taskId],
    );
  }

  /** One approved, picked-up, applied and settled attempt: 1800 spent of 2500 held. */
  async function settledWork(): ReturnType<T3aHarness['settledWork']> {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const [envelope] = await envelopes(w.taskId);
    expect(envelope).toMatchObject({ state: 'open', held: '0', actual: '1800' });
    return { w, envelopeId: String(envelope?.id), lineageId: String(w.proposal['lineageId']) };
  }

  return { work, applied, observeOf, envelopes, settledWork };
}
