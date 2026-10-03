// SPDX-License-Identifier: AGPL-3.0-only
//
// P26's re-bind review (round 2) of the live correction's records (C80): four
// more lows, each held on a real database in a world of its own, opened by
// round 1's `describeWorld` (`live-correction-lows.ts`) after round 1's is
// dropped, so its lease is live and its delegation not revoked.
//
//   1. Filing a correction locks the task's client.
//
// Registered through `tests/tenancy/restricted-calls.test.ts`, a named suite,
// which calls `describeLiveCorrectionLowsRoundTwo` after round 1.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asPerson, codeOf, revisionOf } from '../runtime/schedules-harness.ts';
import { describeWorld, file, lows, taskOf } from './live-correction-lows.ts';

async function clientOf(taskId: string): Promise<string | null | undefined> {
  const rows = await lows().s.db.admin.execute<{ readonly client: string | null }>(
    'select uuid_7 as client from public.records where id = $1',
    [taskId],
  );
  return rows[0]?.client;
}

async function moveTo(taskId: string, client: string): Promise<string> {
  const { s } = lows();
  return codeOf(
    await asPerson(s, {
      command: 'task.set_party',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { client },
    }),
  );
}

function findingOne(): void {
  it('a task holding only a correction refuses task.set_party and keeps its client', async () => {
    const { s, clientA, clientB } = lows();
    const filedOn = await taskOf(s, clientA);
    expect(await file(filedOn, clientA)).toMatchObject({ taskId: filedOn, partyId: clientA });
    expect(await moveTo(filedOn, clientB)).toBe('CLIENT_LOCKED');
    expect(await clientOf(filedOn)).toBe(clientA);
    // The control: a task of the same client with nothing filed on it still moves.
    const empty = await taskOf(s, clientA);
    expect(await moveTo(empty, clientB)).toBe('applied');
    expect(await clientOf(empty)).toBe(clientB);
  });
}

/** Round 2's findings, each its own block over one world. */
export function describeLiveCorrectionLowsRoundTwo(): void {
  describeWorld('P26 lows round 2: the live correction records', 'p26lows2', () => {
    describe('finding 1: filing a correction locks the task’s client', findingOne);
  });
}
