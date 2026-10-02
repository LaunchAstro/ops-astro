// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-10, the escalation half, against a real database: once a gate is
// escalated (T3a) only a holder of decide across the business decides it
// (`escalatedDecider`), so task.board must stop telling an approver who holds
// decide on that one task that the gate waits on them. Before the escalation
// the same approver is shown it (the positive case), and the business-wide
// decider is shown it after. The Review chip's live count (`owed`, INB-1)
// agrees with the rows each time.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  createTask,
  openSchedules,
  propose,
  type Body,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('review-2c1-10-board-escalated: DATABASE_URL is unset, so nothing below ran.');
}

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the board escalation case`,
  ...extra,
});

let s: Schedules;
let holder: Member;
let approver: Member;
let taskId = '';
let v3: Detail = {};

/** The reader's board: each served task's flag, and the live count it sent. */
const boardOf = async (
  member: Member,
): Promise<{ readonly flags: Readonly<Record<string, boolean>>; readonly owed: unknown }> => {
  const answer = await executeRead(s.db.app, s.business, member.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  const rows = answer.tasks as unknown as readonly { id: string; awaitingDecision: boolean }[];
  const flags = Object.fromEntries(rows.map((row) => [row.id, row.awaitingDecision]));
  return { flags, owed: 'owed' in answer ? answer.owed : undefined };
};

const waitingCount = (flags: Readonly<Record<string, boolean>>): number =>
  Object.values(flags).filter(Boolean).length;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('rb2c1_10_esc', 1_000_000);
  holder = await enrol(s.db.app, s.business, 'escalation-holder');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, holder, 'read');
    await grantTo(tx, holder, 'decide');
  });
  taskId = await createTask(s, `review 2c1 10 escalated ${randomUUID()}`);
  // read, write and decide on exactly this task: the approver's role.
  approver = await enrol(s.db.app, s.business, 'approver');
  const only = { kind: 'record', id: taskId } as const;
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, approver, 'read', only);
    await grantTo(tx, approver, 'write', only);
    await grantTo(tx, approver, 'decide', only);
  });
  // Two rounds of changes, so the third version's gate is at the bound.
  const v1 = await propose(s, taskId);
  appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
  const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
  appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
  v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
}, 240_000);

afterAll(async () => {
  await s?.db.drop();
});

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-10 awaitingDecision and escalation', () => {
  it('REVIEW-2C1-10: a pending gate on a task the reader holds decide on is shown awaiting them, and the count agrees', async () => {
    const seen = await boardOf(approver);
    expect(seen.flags[taskId]).toBe(true);
    expect(seen.owed).toBe(waitingCount(seen.flags));
  });

  it('REVIEW-2C1-10: an escalated gate is not shown awaiting a reader with only a record decide grant, which task.decide refuses them, and the count agrees', async () => {
    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
      'escalate',
    );
    // The premise: decide refuses the record-scoped approver now (T3a).
    const attempt = await executeCommand(
      s.db.app,
      s.business,
      approver.presented,
      'api',
      decideBody(v3, 'approve') as never,
    );
    expect(codeOf(attempt)).toBe('SCOPE_NOT_GRANTED');

    const seen = await boardOf(approver);
    expect(seen.flags[taskId], 'awaitingDecision on an escalated gate').toBe(false);
    expect(seen.owed).toBe(waitingCount(seen.flags));
    // A holder of decide across the business still decides it, and is shown it.
    const wide = await boardOf(holder);
    expect(wide.flags[taskId]).toBe(true);
    expect(wide.owed).toBe(waitingCount(wide.flags));
  });
});
