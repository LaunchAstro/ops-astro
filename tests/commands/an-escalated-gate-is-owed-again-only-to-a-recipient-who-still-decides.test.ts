// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalated gate names the person it was escalated to, and that name stays
// on the gate as history. Their inbox item follows authority instead: when the
// task's assignment moves and the gate's decision items are raised again, the
// recipient is owed one only while they still hold `decide` across the
// business. One whose grant was revoked after the escalation keeps their item
// withdrawn, and one who still decides has it reopened.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  appliedDetail,
  asPerson,
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

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the escalated recipient cases`,
  ...extra,
});

describe.skipIf(serverUrl === undefined)('an escalated gate and its recipient’s authority', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('escalated_recipient', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** A task whose gate is escalated to a business decider, who is then assigned the task. */
  async function escalatedToTheAssignee(): Promise<{
    readonly taskId: string;
    readonly gateId: unknown;
    readonly recipient: Member;
    readonly decideGrant: string;
  }> {
    const recipient = await enrol(s.db.app, s.business, `recipient-${randomUUID()}`);
    const decideGrant = await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, recipient, 'read');
      return await grantTo(tx, recipient, 'decide');
    });
    const taskId = await createTask(s, `escalated recipient ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
    const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
    const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: recipient.personId })),
      'escalate',
    );
    await assign(taskId, recipient.personId);
    expect(await itemState(v3['gateId'], recipient.personId)).toBe('withdrawn');
    return { taskId, gateId: v3['gateId'], recipient, decideGrant };
  }

  async function assign(taskId: string, assignee: string): Promise<void> {
    appliedDetail(
      await asPerson(s, {
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(s, taskId),
        fields: { assignee },
      }),
      'assign',
    );
  }

  async function itemState(gateId: unknown, person: string): Promise<string | undefined> {
    const found = await rows<{ readonly state: string }>(
      s,
      `select work_state as state from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate' and fact_id = $2
          and recipient_person_id = $3`,
      [s.business, gateId, person],
    );
    return found[0]?.state;
  }

  it('a recipient whose decide was revoked is not owed the gate again when the task is reassigned', async () => {
    const { taskId, gateId, recipient, decideGrant } = await escalatedToTheAssignee();
    await s.db.app.withBusiness(s.business, async (tx) => {
      expect(await revokeGrant(tx, decideGrant)).not.toBeNull();
    });
    await assign(taskId, s.decider.personId);
    expect(await itemState(gateId, recipient.personId)).toBe('withdrawn');
  });

  it('a recipient who still decides is owed the gate again when the task is reassigned', async () => {
    const { taskId, gateId, recipient } = await escalatedToTheAssignee();
    await assign(taskId, s.decider.personId);
    expect(await itemState(gateId, recipient.personId)).toBe('open');
  });
});
