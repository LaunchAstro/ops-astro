// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-11, red proof, against a real database: task.board serves
// internal fields (estimateMinutes, actualMinutes, rank and the rest) to a
// member whose role is not internal. Its serve (reads/catalogue.ts) never asks
// `isInternalReader`, as task.ledger and team.list do, and the dispatcher
// (reads/dispatch.ts) skips the grant check for a `declared-within` list read
// whenever the session has a role, so the live channel's `admitReads` admits
// it too. A member with role_key 'client' (memberships_role_key_shape allows
// it) and one record task:read grant must be refused the board, failing
// closed (owner ruling). Fixed when both the read and the admission refuse.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { admitReads, executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { CANARY, outcomeOf, timeWorld, type TimeWorld } from '../commands/time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'review-2c1-11-board-client-role: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;
let client: Member;
let taskId = '';

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('rb11');
  taskId = await w.fresh(w.alpha, w.ada, 'estimated, shared with a client');
  const [row] = await w.db.admin.execute<{ readonly revision: number }>(
    'select revision::int as revision from public.records where id = $1',
    [taskId],
  );
  const updated = await w.as(w.alpha, w.ada, {
    command: 'task.update',
    recordId: taskId,
    expectedRevision: row?.revision,
    fields: { estimated_minutes: 120 },
  });
  expect(outcomeOf(updated)).toStrictEqual({ applied: true });
  client = await enrol(w.db.app, w.alpha, 'client-carol');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(`update memberships set role_key = 'client' where person_id = $1`, [
      client.personId,
    ]);
    await grantTo(tx, client, 'read', { kind: 'record', id: taskId });
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-11 task.board and a non-internal role', () => {
  it('REVIEW-2C1-11: task.board refuses a member with role_key client holding one record task:read grant, and serves no internal field', async () => {
    const answer = await executeRead(w.db.app, w.alpha, client.presented, {
      read: 'task.board',
      board: null,
    });
    const body = JSON.stringify(answer);
    expect(
      isCommandRefusal(answer),
      `task.board served a client role instead of refusing: ${body.slice(0, 400)}`,
    ).toBe(true);
    expect(body).not.toMatch(/estimateMinutes|actualMinutes/u);
  });

  it('REVIEW-2C1-11: admitReads refuses task.board to a member with role_key client holding one record task:read grant', async () => {
    const admitted = await admitReads(
      w.db.app,
      w.alpha,
      client.presented,
      [{ read: 'task.board', board: null }],
      'door',
    );
    // The login itself is admitted; it is the board read that must be refused.
    expect(isCommandRefusal(admitted) ? admitted.code : 'login admitted').toBe('login admitted');
    const first = isCommandRefusal(admitted) ? undefined : admitted[0];
    expect(
      first !== undefined && isCommandRefusal(first),
      `admitReads admitted task.board for a client role: ${JSON.stringify(admitted)}`,
    ).toBe(true);
  });
});

/** The board a reader is served, with the estimated task's row, and the live channel's admission. */
const getsTheBoard = async (who: string, member: Member): Promise<void> => {
  const answer = await executeRead(w.db.app, w.alpha, member.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board refused ${who}: ${JSON.stringify(answer)}`);
  }
  expect(answer.tasks.find((task) => task.id === taskId)?.estimateMinutes, who).toBe(120);
  const admitted = await admitReads(
    w.db.app,
    w.alpha,
    member.presented,
    [{ read: 'task.board', board: null }],
    'door',
  );
  const first = isCommandRefusal(admitted) ? admitted : admitted[0];
  expect(first !== undefined && !isCommandRefusal(first), who).toBe(true);
};

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-11 the ruling, by name', () => {
  it('REVIEW-2C1-11: a client-role member with a record grant is refused task.board', async () => {
    const answer = await executeRead(w.db.app, w.alpha, client.presented, {
      read: 'task.board',
      board: taskId,
    });
    // The answer an unadmitted read gets (`admits`): the one NOT_FOUND.
    expect(isCommandRefusal(answer) ? answer.code : 'served').toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(taskId);
    // task.read stays as it was: the shared view of the one task it holds.
    const shared = await executeRead(w.db.app, w.alpha, client.presented, {
      read: 'task.read',
      recordId: taskId,
    });
    expect('sharedTask' in shared).toBe(true);
  });

  it('REVIEW-2C1-11: an internal member still gets the board', async () => {
    await getsTheBoard('ada', w.ada);
    // client-a is an internal member ('member') holding no task read yet.
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskId });
    });
    await getsTheBoard('a record-grant member', w.clientA);
  });
});

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-11 across businesses', () => {
  it('REVIEW-2C1-11: a business-to-business crossing is still refused task.board', async () => {
    const bravoTask = await w.fresh(w.bravo, w.bravoOwner, `bravo board ${CANARY}`);
    // Alpha's owner naming bravo's task as a board: not here.
    const named = await executeRead(w.db.app, w.alpha, w.ada.presented, {
      read: 'task.board',
      board: bravoTask,
    });
    expect(isCommandRefusal(named) ? named.code : 'served').toBe('NOT_FOUND');
    // Bravo's owner reading alpha's board: no standing here at all.
    const crossed = await executeRead(w.db.app, w.alpha, w.bravoOwner.presented, {
      read: 'task.board',
      board: null,
    });
    expect(isCommandRefusal(crossed)).toBe(true);
    for (const body of [JSON.stringify(named), JSON.stringify(crossed)]) {
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(taskId);
    }
  });
});
