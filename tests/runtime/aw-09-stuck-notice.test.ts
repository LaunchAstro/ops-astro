// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09's stuck-work notice, over a real database through the command entry.
// The agent is stuck when it hands its work back failed: the run waits on a
// person's move. The inbox transition that settles it tells the person who
// authorised the run (its requester, INB-1) and, for agent work, the task's
// assignee too (issue 19: escalation when stuck goes to the assignee in
// version 1). The notice is a pointer and grants nothing:
//
// - the assignee is raised one waiting item on the run, and holds no more
//   grants than before; the agent's output for review is still not theirs to
//   decide (four eyes), and no decision item is raised to them;
// - an assignee who is also the requester is recorded once, as the requester's
//   own waiting item, and that confers no decision authority either;
// - nobody else in the business is told (person to person).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  handbackBody,
  liveWork,
  openSchedules,
  revisionOf,
  rows,
  type Body,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import { decideBody } from './t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Item {
  readonly reason: string;
  readonly fact_kind: string;
  readonly fact_id: string;
  readonly owed: boolean;
}

// eslint-disable-next-line max-lines-per-function -- two notices over one world
describe.skipIf(serverUrl === undefined)('AW-09 the stuck-work notice', () => {
  let s: Schedules;
  let assignee: Member;
  let bystander: Member;

  beforeAll(async () => {
    s = await openSchedules('aw09_stuck', 1_000_000);
    assignee = await enrol(s.db.app, s.business, 'aw09-assignee');
    bystander = await enrol(s.db.app, s.business, 'aw09-bystander');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const member of [assignee, bystander]) {
        // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's rows
        await grantTo(tx, member, 'read');
        // eslint-disable-next-line no-await-in-loop -- one grant at a time
        await grantTo(tx, member, 'write');
      }
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const assign = async (taskId: string, person: string): Promise<void> => {
    const body = {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { assignee: person },
    };
    appliedDetail(await asPerson(s, body), 'task.assign');
  };

  /** The agent hands its work back failed, with its output for review. */
  const stuck = async (work: Work) => {
    const successor: Body = {
      purpose: freshPurpose(),
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: 'what I managed before I got stuck' },
      step: { kind: 'compose', payload: {} },
    };
    const body = { ...handbackBody(work.picked, successor), outcome: 'failed' };
    const settled = await asAgent(s, body, String(work.picked['credential']));
    return appliedDetail(settled, 'failed handback');
  };

  const items = async (person: string, taskId: string) =>
    await rows<Item>(
      s,
      `select reason, fact_kind, fact_id::text, owed from public.inbox_items
        where business_id = $1 and recipient_person_id = $2 and subject_record_id = $3
          and work_state = 'open' order by reason`,
      [s.business, person, taskId],
    );
  const grantsOf = async (person: string) =>
    await rows<{ readonly id: string }>(
      s,
      `select id from public.grants where business_id = $1 and subject_id = $2 order by id`,
      [s.business, person],
    );
  const decideAs = async (member: Member, at: Body) =>
    codeOf(await executeCommand(s.db.app, s.business, member.presented, 'api', at as never));

  it('a stuck agent tells the task assignee one waiting item, and the notice grants nothing', async () => {
    const work = await liveWork(s, `aw-09 stuck ${randomUUID()}`, 2_000);
    await assign(work.taskId, assignee.personId);
    const grants = await grantsOf(assignee.personId);
    const handedBack = await stuck(work);
    const waiting = { reason: 'waiting_run', fact_kind: 'planned_run', owed: true };
    const runId = String(work.proposal['runId']);

    // Its assignment item, and the notice.
    expect(await items(assignee.personId, work.taskId)).toEqual([
      { reason: 'assignment', fact_kind: 'record', fact_id: work.taskId, owed: true },
      { ...waiting, fact_id: runId },
    ]);
    expect(await items(s.decider.personId, work.taskId)).toContainEqual({
      ...waiting,
      fact_id: runId,
    });
    expect(await items(bystander.personId, work.taskId)).toEqual([]);
    expect(await grantsOf(assignee.personId)).toEqual(grants);
    const output = {
      gateId: handedBack['successorGateId'],
      versionId: handedBack['successorVersionId'],
    };
    expect(await decideAs(assignee, decideBody(output, 'approve'))).not.toBe('applied');
  });

  it('a stuck-work notice to an assignee who is also the requester is their one waiting item, and confers no decision authority', async () => {
    const work = await liveWork(s, `aw-09 stuck self ${randomUUID()}`, 2_000);
    await assign(work.taskId, s.decider.personId);
    const grants = await grantsOf(s.decider.personId);
    const handedBack = await stuck(work);
    const output = {
      gateId: handedBack['successorGateId'],
      versionId: handedBack['successorVersionId'],
    };

    expect(await items(s.decider.personId, work.taskId)).toEqual([
      {
        reason: 'waiting_run',
        fact_kind: 'planned_run',
        fact_id: String(work.proposal['runId']),
        owed: true,
      },
    ]);
    expect(await grantsOf(s.decider.personId)).toEqual(grants);
    expect(await decideAs(s.decider, decideBody(output, 'approve'))).toBe('FOUR_EYES_REQUIRED');
  });
});
