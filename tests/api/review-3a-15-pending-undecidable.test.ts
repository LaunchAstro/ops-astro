// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-15: `gate.pending` must not promise a decision the reader cannot
// make. The list is filtered by the caller's `decide` grant alone
// (`reads/awaiting-review.ts`), while `task.decide` refuses two more callers
// under its locks (`core-runtime/src/decide.ts`, `recheckDecision`):
//
// - four eyes (T2g): the task's assignee does not decide its gate, whatever
//   `decide` they hold (`FOUR_EYES_REQUIRED`);
// - escalation (T3a): an escalated gate is decided only by a holder of
//   `decide` at business scope, so a record-scoped decider is refused
//   (`SCOPE_NOT_GRANTED`).
//
// Each case shows the decision refused through the real boundary, then asks
// `gate.pending` as the same caller and expects the gate left out. A control
// gate the same caller can decide stays listed, so the list is answering.
// Fixed when the read applies the same two filters as the decide path.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const decideBody = (
  proposal: Record<string, unknown>,
  decision: string,
  extra: Record<string, unknown> = {},
) => ({
  gateId: proposal['gateId'],
  versionId: proposal['versionId'],
  decision,
  note: `${decision} in REVIEW-3A-15`,
  ...extra,
});

// eslint-disable-next-line max-lines-per-function -- one world, the two undecidable cases
describe.skipIf(serverUrl === undefined)('REVIEW-3A-15 gate.pending', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('review_3a_15');
  }, 180_000);

  afterAll(async () => await c?.drop());

  const revisionOf = async (taskId: string): Promise<number> =>
    await c.count(
      `select revision::text as n from public.records where business_id = $1 and id = $2`,
      [c.fixture.business, taskId],
    );

  const pendingIds = async (as: Member): Promise<string[]> => {
    const answer = await c.asPerson('gate.pending', {}, as);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return (answer.body['awaiting'] as { gateId: string }[]).map((row) => row.gateId);
  };

  /** A further version on the same lineage, through `task.propose`. */
  const revise = async (
    taskId: string,
    lineageId: unknown,
    purpose: string,
  ): Promise<Record<string, unknown>> => {
    const answer = await c.asPerson('task.propose', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      ...PROPOSAL,
      purpose,
      lineageId,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return detailOf(answer);
  };

  async function enrolWith(
    name: string,
    actions: readonly ('read' | 'decide')[],
    scopeTasks?: readonly string[],
  ): Promise<Member> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, `${name}-${randomUUID()}`);
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      for (const action of actions) {
        if (scopeTasks === undefined) {
          // eslint-disable-next-line no-await-in-loop -- issueGrant reads the granter's rows
          await grantTo(tx, member, action);
        } else {
          for (const id of scopeTasks) {
            // eslint-disable-next-line no-await-in-loop -- as above
            await grantTo(tx, member, action, { kind: 'record', id });
          }
        }
      }
    });
    return member;
  }

  it('REVIEW-3A-15: gate.pending lists to the task’s assignee a gate four eyes forbids them to decide', async () => {
    // A business-wide decider, who is also assigned one task.
    const assignee = await enrolWith('assignee', ['read', 'decide']);
    const mine = await c.createTask('REVIEW-3A-15 assigned to the decider');
    const assigned = await c.asPerson('task.assign', {
      recordId: mine.id,
      expectedRevision: mine.revision,
      fields: { assignee: assignee.personId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const own = await c.propose(mine.id, await revisionOf(mine.id), 'review_3a_15_own');

    // Control: a gate on a task assigned to nobody, which they may decide.
    const other = await c.createTask('REVIEW-3A-15 not assigned');
    const control = await c.propose(other.id, other.revision, 'review_3a_15_other');

    // The decision is refused: the assignee does not decide their own task's gate.
    const refused = await c.asPerson('task.decide', decideBody(own, 'approve'), assignee);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body['code']).toBe('FOUR_EYES_REQUIRED');

    const listed = await pendingIds(assignee);
    expect(listed).toContain(control['gateId']);
    expect(
      listed,
      'gate.pending offers the assignee a gate task.decide refuses FOUR_EYES_REQUIRED',
    ).not.toContain(own['gateId']);
  });

  it('REVIEW-3A-15: gate.pending lists an escalated gate to a record-scoped decider the escalation took it from', async () => {
    const task = await c.createTask('REVIEW-3A-15 escalated');
    const control = await c.createTask('REVIEW-3A-15 not escalated');
    const scoped = await enrolWith('scoped', ['read', 'decide'], [task.id, control.id]);
    const holder = await enrolWith('escalation-holder', ['read', 'decide']);

    // Two rounds of changes, then the third version is at the bound.
    const purpose = 'review_3a_15_escalated';
    const v1 = await c.propose(task.id, task.revision, purpose);
    expect((await c.asPerson('task.decide', decideBody(v1, 'request_changes'))).status).toBe(200);
    const v2 = await revise(task.id, v1['lineageId'], purpose);
    expect((await c.asPerson('task.decide', decideBody(v2, 'request_changes'))).status).toBe(200);
    const v3 = await revise(task.id, v1['lineageId'], purpose);
    const escalated = await c.asPerson(
      'task.decide',
      decideBody(v3, 'escalate', { recipientPersonId: holder.personId }),
    );
    expect(escalated.status, JSON.stringify(escalated.body)).toBe(200);

    const open = await c.propose(control.id, control.revision, 'review_3a_15_control');

    // The record-scoped decider can no longer decide the escalated gate.
    const refused = await c.asPerson('task.decide', decideBody(v3, 'reject'), scoped);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');

    const listed = await pendingIds(scoped);
    expect(listed).toContain(open['gateId']);
    expect(
      listed,
      'gate.pending offers a record-scoped decider an escalated gate task.decide refuses SCOPE_NOT_GRANTED',
    ).not.toContain(v3['gateId']);
    // The escalation holder still sees it.
    expect(await pendingIds(holder)).toContain(v3['gateId']);
  });
});
