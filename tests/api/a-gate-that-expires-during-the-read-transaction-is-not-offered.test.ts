// SPDX-License-Identifier: AGPL-3.0-only
//
// `gate.pending` and the board's approval wait offer only a gate a decision
// could still meet (`awaiting-review.ts`, `awaiting.ts`). The instant a gate's
// deadline is judged at must be read when the read is served, not when its
// transaction began: a gate whose deadline passes while the read's
// transaction is held up is not offered, as `task.decide` refuses it
// `GATE_EXPIRED`.
//
// Each read's transaction begins with the gate a second from its deadline,
// waits on the database clock until the deadline has passed, and only then is
// served.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../packages/core-records/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The board's row for `taskId`, if it has one. */
const boardRow = (board: unknown, taskId: string): unknown =>
  (board as { readonly tasks?: readonly { readonly id: string }[] }).tasks?.find(
    (row) => row.id === taskId,
  );

const waitOf = (row: unknown): Readonly<Record<string, unknown>> => {
  const { waitReason, awaitingDecision } = (row ?? {}) as Record<string, unknown>;
  return { waitReason, awaitingDecision };
};

describe.skipIf(serverUrl === undefined)('reading a gate across its deadline', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('gatereaddeadline');
  }, 180_000);

  afterAll(async () => await c?.drop());

  /**
   * The application's database, but every transaction begins with the gate a
   * second from its deadline and is served only once the database clock is
   * past it. `startedLive` keeps whether each began while the gate was live.
   */
  function heldPastDeadline(gateId: unknown, startedLive: boolean[]): Database {
    const app = c.fixture.db.app;
    return {
      ...app,
      async withBusiness(business, run) {
        await c.fixture.db.admin.execute(
          `update public.gates set expires_at = clock_timestamp() + interval '1 second'
            where id = $1`,
          [gateId],
        );
        return await app.withBusiness(business, async (tx) => {
          const [gate] = await tx.query<{ readonly live: boolean }>(
            'select now() < expires_at as live from public.gates where id = $1',
            [gateId],
          );
          startedLive.push(gate?.live === true);
          await tx.query(
            `select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp())) + 0.05)
               from public.gates where id = $1`,
            [gateId],
          );
          return await run(tx);
        });
      },
    };
  }

  it('a gate that expires during the read transaction is not offered after its deadline', async () => {
    const task = await c.createTask('read across the gate deadline');
    const proposal = await c.propose(task.id, task.revision);
    const gateId = String(proposal['gateId']);
    const reader = c.manager.presented;

    // While the gate is live both reads offer it.
    const livePending = await executeRead(c.fixture.db.app, c.fixture.business, reader, {
      read: 'gate.pending',
    });
    const liveBoard = await executeRead(c.fixture.db.app, c.fixture.business, reader, {
      read: 'task.board',
      board: null,
    });
    expect({
      offered: JSON.stringify(livePending).includes(gateId),
      wait: waitOf(boardRow(liveBoard, task.id)),
    }).toEqual({
      offered: true,
      wait: { waitReason: 'needs_approval', awaitingDecision: true },
    });

    const startedLive: boolean[] = [];
    const pending = await executeRead(
      heldPastDeadline(gateId, startedLive),
      c.fixture.business,
      reader,
      { read: 'gate.pending' },
    );
    const board = await executeRead(
      heldPastDeadline(gateId, startedLive),
      c.fixture.business,
      reader,
      { read: 'task.board', board: null },
    );
    const decision = await c.asPerson('task.decide', {
      gateId,
      versionId: proposal['versionId'],
      decision: 'reject',
      note: 'the deadline has passed',
    });
    expect({
      startedLive,
      decide: decision.body['code'],
      offered: JSON.stringify(pending).includes(gateId),
      wait: waitOf(boardRow(board, task.id)),
    }).toEqual({
      startedLive: [true, true],
      decide: 'GATE_EXPIRED',
      offered: false,
      wait: { waitReason: null, awaitingDecision: false },
    });
  }, 60_000);
});
