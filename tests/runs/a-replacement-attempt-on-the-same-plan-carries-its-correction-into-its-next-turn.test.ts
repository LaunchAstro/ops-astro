// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2090-1 on #2090 (copied unchanged but for its names): a
// replacement attempt on the same accepted plan, after an unmarked drop, is
// answered the plan's one correction (#1717, owner ruling Q2) and carries it
// into its next model turn under its own lease and delegation.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appliedDetail, asAgent, createTask, pickup } from '../runtime/schedules-harness.ts';
import {
  OWN_PAGE,
  ownSiteOf,
  requestAsAgent,
  requestOf,
  workOn,
  namingCorrection,
} from './agent-draft-world.ts';
import { asWorker, door, noDatabase, s, useStopWorld } from './run-stop-world.ts';

useStopWorld('r8areplacement');
beforeAll(async () => {
  if (!noDatabase) await ownSiteOf(s, OWN_PAGE);
});

describe.skipIf(noDatabase)('a replacement attempt on the same accepted plan', () => {
  it('carries the correction it was answered into its next model turn', async () => {
    const first = await workOn(await createTask(s, 'a correction before an unmarked drop'));
    const requested = await requestAsAgent(first, requestOf(first.taskId));
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const dropped = await asWorker(door(), first, 'task/handback', {
      operationId: randomUUID(),
      leaseId: first.picked['leaseId'],
      fence: first.picked['fence'],
      outcome: 'dropped',
      report: { dropCause: 'connection_lost' },
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
    const queued = appliedDetail(
      await asAgent(s, { command: 'task.queue', operationId: randomUUID() }),
      'queue',
    )['queue'] as { taskId: string; reservationId: string; versionId: string }[];
    const next = queued.find((q) => q.taskId === first.taskId);
    expect(next, JSON.stringify(queued)).toBeDefined();
    expect(next!.versionId).toBe(first.proposal['versionId']);
    const replacement = { ...first, picked: await pickup(s, next!.reservationId) };
    expect(replacement.picked['attemptId']).not.toBe(first.picked['attemptId']);
    expect(replacement.picked['delegationId']).not.toBe(first.picked['delegationId']);
    const asked = await requestAsAgent(replacement, requestOf(first.taskId));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const correctionId = String((asked.body['detail'] as Record<string, unknown>)['correctionId']);
    const { answer } = await namingCorrection(replacement, correctionId);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  }, 120000);
});
