// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 and four eyes (T2g), over a real database through the command entry.
//
// The person a task is assigned to never decides its gate, so the inbox owes
// them no decision on it: a new gate raises the assignee none, assigning a
// decider withdraws the open decision item they held on the task, and
// reassigning the task reopens it, so they are owed it again. The escalated
// gate's case is in `inbox-escalate.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { countOwed } from '../../packages/core-commands/src/reads/inbox.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  createTask,
  openSchedules,
  propose,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const decideBody = (version: Detail, decision: string): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the inbox four eyes cases`,
});

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1 four eyes and the inbox', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('inb1_four_eyes', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const as = async (member: Member, body: Body) =>
    await executeCommand(s.db.app, s.business, member.presented, 'api', body as never);

  /** read, write and decide on exactly one task: the approver's role. */
  async function approverOn(taskId: string): Promise<Member> {
    const member = await enrol(s.db.app, s.business, `approver-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, member, action, { kind: 'record', id: taskId });
      }
    });
    return member;
  }

  /** The decision item `person` holds on the gate, by its work state. */
  const stateOn = async (gateId: unknown, person: string): Promise<string | undefined> =>
    (
      await rows<{ readonly state: string }>(
        s,
        `select work_state as state from public.inbox_items
          where business_id = $1 and reason = 'decision' and fact_kind = 'gate'
            and fact_id = $2 and recipient_person_id = $3`,
        [s.business, gateId, person],
      )
    )[0]?.state;

  const owed = async (person: string): Promise<number> =>
    await s.db.app.withBusiness(s.business, async (tx) => await countOwed(tx, person));

  const assign = async (taskId: string, assignee: Member): Promise<void> => {
    appliedDetail(
      await asPerson(s, {
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(s, taskId),
        fields: { assignee: assignee.personId },
      }),
      'assign a decider',
    );
  };

  it('INB-1 four eyes: a new gate raises no decision item for the task’s assignee', async () => {
    const taskId = await createTask(s, `inbox four eyes ${randomUUID()}`);
    const approver = await approverOn(taskId);
    await assign(taskId, approver);
    const v1 = await propose(s, taskId);
    expect(codeOf(await as(approver, decideBody(v1, 'approve')))).toBe('FOUR_EYES_REQUIRED');
    expect(await stateOn(v1['gateId'], approver.personId)).toBeUndefined();
    // Their assignment item alone: it is owed.
    expect(await owed(approver.personId)).toBe(1);
  });

  it('INB-1 four eyes: assigning a decider withdraws their open decision item on the task', async () => {
    const taskId = await createTask(s, `inbox four eyes later ${randomUUID()}`);
    const approver = await approverOn(taskId);
    const v1 = await propose(s, taskId);
    expect(await stateOn(v1['gateId'], approver.personId)).toBe('open');
    await assign(taskId, approver);
    expect(await stateOn(v1['gateId'], approver.personId)).toBe('withdrawn');
    // Their assignment item alone: it is owed.
    expect(await owed(approver.personId)).toBe(1);
  });

  it('INB-1 four eyes: a reassignment racing a decision leaves no open decision item on the decided gate', async () => {
    const taskId = await createTask(s, `inbox four eyes race ${randomUUID()}`);
    const first = await approverOn(taskId);
    const second = await approverOn(taskId);
    const third = await approverOn(taskId);
    const version = await propose(s, taskId);
    await assign(taskId, first);
    expect(await stateOn(version['gateId'], first.personId)).toBe('withdrawn');
    // Both take the task's record row: whichever commits second sees the first.
    const [, decided] = await Promise.all([
      assign(taskId, second),
      as(third, decideBody(version, 'approve')),
    ]);
    expect(codeOf(decided)).toBe('applied');
    const open = await rows<{ readonly total: number }>(
      s,
      `select count(*)::int as total from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate'
          and fact_id = $2 and work_state = 'open'`,
      [s.business, version['gateId']],
    );
    expect(open[0]?.total).toBe(0);
    expect(await owed(first.personId)).toBe(0);
  });

  it('a former assignee regains an open decision item when reassigned', async () => {
    const taskId = await createTask(s, `inbox four eyes released ${randomUUID()}`);
    const first = await approverOn(taskId);
    const second = await approverOn(taskId);
    const version = await propose(s, taskId);
    expect(await stateOn(version['gateId'], first.personId)).toBe('open');
    await assign(taskId, first);
    expect(await stateOn(version['gateId'], first.personId)).toBe('withdrawn');
    await assign(taskId, second);
    const restored = await stateOn(version['gateId'], first.personId);
    const count = await owed(first.personId);
    expect(codeOf(await as(first, decideBody(version, 'approve')))).toBe('applied');
    expect(restored).toBe('open');
    expect(count).toBe(1);
  });

  it("reassignment restores an eligible decider's gate item", async () => {
    const taskId = await createTask(s, `inbox four eyes reassigned ${randomUUID()}`);
    const approver = await approverOn(taskId);
    const replacement = await enrol(s.db.app, s.business, `replacement-${randomUUID()}`);
    const version = await propose(s, taskId);
    expect(await stateOn(version['gateId'], approver.personId)).toBe('open');

    await assign(taskId, approver);
    expect(await stateOn(version['gateId'], approver.personId)).toBe('withdrawn');
    await assign(taskId, replacement);

    const open = await rows<{ readonly total: number }>(
      s,
      `select count(*)::int as total from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate'
          and fact_id = $2 and recipient_person_id = $3 and work_state = 'open'`,
      [s.business, version['gateId'], approver.personId],
    );
    const countBeforeDecision = await owed(approver.personId);
    appliedDetail(await as(approver, decideBody(version, 'approve')), 'eligible former assignee');
    expect(open[0]?.total).toBe(1);
    expect(countBeforeDecision).toBe(1);
  });
});
