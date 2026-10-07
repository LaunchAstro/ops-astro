// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's approval wait (`awaiting.ts`) offers only a gate a decision
// could still meet. `task.cancel` ends the lineage and leaves its gate row
// pending, and `task.decide` then refuses that gate `LINEAGE_TERMINAL`, so a
// cancelled proposal waits on nobody: the board draws no `needs_approval`
// and no decision of the reader's, as `gate.pending` lists none.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the board after a proposal is cancelled', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('cancelledwait');
  }, 180_000);

  afterAll(async () => await c?.drop());

  /** The board row's wait and the reader's pending list, for one task and gate. */
  async function seen(taskId: string, gateId: string): Promise<Record<string, unknown>> {
    const reader = c.manager.presented;
    const board = await executeRead(c.fixture.db.app, c.fixture.business, reader, {
      read: 'task.board',
      board: null,
    });
    const pending = await executeRead(c.fixture.db.app, c.fixture.business, reader, {
      read: 'gate.pending',
    });
    const row = (board as { readonly tasks?: readonly Record<string, unknown>[] }).tasks?.find(
      (each) => each['id'] === taskId,
    );
    return {
      waitReason: row?.['waitReason'],
      awaitingDecision: row?.['awaitingDecision'],
      pending: JSON.stringify(pending).includes(gateId),
    };
  }

  it('cancelling a pending lineage removes its board approval wait', async () => {
    const task = await c.createTask('a proposal cancelled before its decision');
    const proposal = await c.propose(task.id, task.revision, 'cancel_before_decision');
    const gateId = String(proposal['gateId']);
    expect(await seen(task.id, gateId)).toEqual({
      waitReason: 'needs_approval',
      awaitingDecision: true,
      pending: true,
    });

    const cancelled = await c.asPerson('task.cancel', {
      recordId: task.id,
      lineageId: proposal['lineageId'],
      reason: 'no longer wanted',
    });
    expect(cancelled.status).toBe(200);
    const [gate] = await c.fixture.db.admin.execute<{ readonly state: string }>(
      'select state from public.gates where id = $1',
      [gateId],
    );
    const decided = await c.asPerson('task.decide', {
      gateId,
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'the proposal was cancelled',
    });

    expect({ gate: gate?.state, decide: decided.body['code'], ...(await seen(task.id, gateId)) })
      .toEqual({
        gate: 'pending',
        decide: 'LINEAGE_TERMINAL',
        waitReason: null,
        awaitingDecision: false,
        pending: false,
      });
  }, 60_000);
});
