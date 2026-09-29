// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 and T3a's escalate, over a real database through the command entry.
//
// Escalating a gate at the revision bound decides nothing: the gate stays
// pending and from then on only a holder of `decide` at business scope decides
// it (T3a). The inbox follows the authority: in the escalating transaction a
// person who held decide on the task alone has their item on that gate
// withdrawn, since they can no longer act on it; the recipient holds an open,
// owed item on it, raised if they had none; the business-scope deciders keep
// theirs. The later decision clears what is left, naming its decider. A
// refused escalation moves no item, and an item about another task that
// points at the gate is not the gate's to move.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { countOwed } from '../../packages/core-commands/src/reads/inbox.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  createTask,
  openSchedules,
  propose,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('commands/inbox-escalate: DATABASE_URL is unset, so nothing below ran.');
}

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the inbox escalation cases`,
  ...extra,
});

interface ItemRow {
  readonly recipient: string;
  readonly subject: string;
  readonly state: string;
  readonly closedBy: string | null;
}

const itemOf = (items: readonly ItemRow[], person: string, subject: string) =>
  items.find((item) => item.recipient === person && item.subject === subject);

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1 escalate and the inbox', () => {
  let s: Schedules;
  let holder: Member;

  beforeAll(async () => {
    s = await openSchedules('inb1_escalate', 1_000_000);
    holder = await enrol(s.db.app, s.business, 'escalation-holder');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, holder, action);
      }
    });
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

  /** A task whose third version's gate is at the bound, its approver raised an item on it. */
  async function atTheBound() {
    const taskId = await createTask(s, `inbox escalate ${randomUUID()}`);
    const approver = await approverOn(taskId);
    const v1 = await propose(s, taskId);
    appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
    const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
    const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    return { taskId, v3, approver };
  }

  const onGate = async (gateId: unknown): Promise<readonly ItemRow[]> =>
    await rows<ItemRow>(
      s,
      `select recipient_person_id as recipient, subject_record_id as subject,
              work_state as state, closed_by_person_id as "closedBy"
         from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate' and fact_id = $2
        order by recipient_person_id`,
      [s.business, gateId],
    );

  const owed = async (person: string): Promise<number> =>
    await s.db.app.withBusiness(s.business, async (tx) => await countOwed(tx, person));

  it('INB-1 escalate withdraws a task-scoped decider’s item and keeps the recipient’s open and owed', async () => {
    const { taskId, v3, approver } = await atTheBound();
    const before = await onGate(v3['gateId']);
    expect(itemOf(before, approver.personId, taskId)?.state).toBe('open');
    expect(itemOf(before, holder.personId, taskId)?.state).toBe('open');
    const approverOwed = await owed(approver.personId);

    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
      'escalate',
    );

    const after = await onGate(v3['gateId']);
    expect(itemOf(after, approver.personId, taskId)).toMatchObject({
      state: 'withdrawn',
      closedBy: null,
    });
    expect(itemOf(after, holder.personId, taskId)?.state).toBe('open');
    expect(itemOf(after, s.decider.personId, taskId)?.state).toBe('open');
    expect(await owed(approver.personId)).toBe(approverOwed - 1);

    // The escalation role decides; what is left on the gate clears naming them.
    appliedDetail(await as(holder, decideBody(v3, 'approve')), 'approve after escalate');
    const decided = await onGate(v3['gateId']);
    expect(decided.filter((item) => item.state === 'open')).toStrictEqual([]);
    expect(itemOf(decided, holder.personId, taskId)).toMatchObject({
      state: 'cleared',
      closedBy: holder.personId,
    });
    expect(itemOf(decided, approver.personId, taskId)?.state).toBe('withdrawn');
  });

  it('INB-1 escalate raises the recipient an item when their grant came after the gate', async () => {
    const { taskId, v3 } = await atTheBound();
    const late = await enrol(s.db.app, s.business, `late-holder-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, late, action);
      }
    });
    expect(itemOf(await onGate(v3['gateId']), late.personId, taskId)).toBeUndefined();

    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: late.personId })),
      'escalate to a later holder',
    );
    expect(itemOf(await onGate(v3['gateId']), late.personId, taskId)?.state).toBe('open');
    expect(await owed(late.personId)).toBe(1);
  });

  it('INB-1 a refused escalate moves no item', async () => {
    const taskId = await createTask(s, `inbox escalate early ${randomUUID()}`);
    const approver = await approverOn(taskId);
    const v1 = await propose(s, taskId);
    const before = await onGate(v1['gateId']);
    // Before the bound, and to a recipient without the role: both refused.
    expect(
      codeOf(await asPerson(s, decideBody(v1, 'escalate', { recipientPersonId: holder.personId }))),
    ).toBe('TRANSITION_NOT_PERMITTED');
    expect(await onGate(v1['gateId'])).toStrictEqual(before);
    expect(itemOf(before, approver.personId, taskId)?.state).toBe('open');
  });

  it('INB-1 escalate leaves an item about another task that names the gate', async () => {
    const { taskId, v3, approver } = await atTheBound();
    const other = await createTask(s, `inbox escalate other ${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await raiseInboxItem(tx, {
        recipientPersonId: approver.personId,
        subjectRecordId: other,
        reason: 'decision',
        fact: { kind: 'gate', id: String(v3['gateId']) },
      });
    });
    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
      'escalate',
    );
    const after = await onGate(v3['gateId']);
    expect(itemOf(after, approver.personId, taskId)?.state).toBe('withdrawn');
    expect(itemOf(after, approver.personId, other)?.state).toBe('open');
  });

  it.each(['escalate first', 'approve first'] as const)(
    'INB-1 escalate and approve at once (%s): one wins, and no item is left owed to someone who cannot act',
    async (order) => {
      const { taskId, v3, approver } = await atTheBound();
      const escalate = () =>
        asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId }));
      const approve = () => as(approver, decideBody(v3, 'approve'));
      type Result = Awaited<ReturnType<typeof escalate>>;
      const race = async (): Promise<readonly [Result, Result]> => {
        if (order === 'escalate first') return await Promise.all([escalate(), approve()]);
        const [second, first] = await Promise.all([approve(), escalate()]);
        return [first, second];
      };
      const [escalated, approved] = await race();
      expect(
        [codeOf(escalated), codeOf(approved)].filter((code) => code === 'applied'),
      ).toHaveLength(1);
      const after = await onGate(v3['gateId']);
      // Whichever committed first, the other was refused under the gate lock
      // and the items match the winner.
      const approverItem = itemOf(after, approver.personId, taskId);
      if (codeOf(approved) === 'applied') {
        expect(after.filter((item) => item.state === 'open')).toStrictEqual([]);
        expect(approverItem).toMatchObject({ state: 'cleared', closedBy: approver.personId });
      } else {
        expect(approverItem?.state).toBe('withdrawn');
        expect(itemOf(after, holder.personId, taskId)?.state).toBe('open');
      }
    },
  );
});
