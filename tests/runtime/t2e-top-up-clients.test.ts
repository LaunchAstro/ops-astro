// SPDX-License-Identifier: AGPL-3.0-only
//
// T2e's client and task separations, over a real database: two external
// clients, each sharing one task of this business and holding a billing grant
// there, read only their own task and top up neither; a member's record-scoped
// grant reaches no other task. Sol's criterion 3 proofs on #130 are moved here
// unchanged from t2e-top-up.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { appliedDetail, codeOf, rows, type Schedules } from './schedules-harness.ts';
import { MAXIMUM, SMALL, openTopUpWorld, type TopUpWorld } from './t2e-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2e-top-up-clients: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('T2e the top-up, clients', () => {
  let w: TopUpWorld;
  let s: Schedules;
  let planner: Member;
  let taskScoped: Member;
  let clientA: Member;
  let clientB: Member;
  let clientTask: string;
  let clientTaskB: string;
  const topUp: TopUpWorld['topUp'] = async (...args) => await w.topUp(...args);
  const maximumOf: TopUpWorld['maximumOf'] = async (...args) => await w.maximumOf(...args);
  const planned: TopUpWorld['planned'] = async (...args) => await w.planned(...args);

  beforeAll(async () => {
    w = await openTopUpWorld('t2eclient');
    ({ s, planner, taskScoped, clientA, clientB, clientTask, clientTaskB } = w);
  }, 180_000);

  afterAll(async () => {
    await w?.s.db.drop();
  });

  it("client to client: each client reads only its own shared task, and neither tops up its own or the other's", async () => {
    const read = async (who: Member, recordId: string): Promise<string> => {
      const answer = await executeRead(s.db.app, s.business, who.presented, {
        read: 'task.read',
        recordId,
      } as never);
      return 'refused' in answer ? String(answer.code) : 'read';
    };
    const cells: [Member, string, string][] = [
      [clientA, clientTask, 'read'],
      [clientA, clientTaskB, 'NOT_FOUND'],
      [clientB, clientTaskB, 'read'],
      [clientB, clientTask, 'NOT_FOUND'],
    ];
    for (const [who, taskId, reads] of cells) {
      // The share is real: each reads its own task, and the other's reads as absent.
      // eslint-disable-next-line no-await-in-loop
      expect(await read(who, taskId)).toBe(reads);
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await topUp(who, taskId, SMALL, MAXIMUM))).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await maximumOf(clientTask)).toBe(MAXIMUM);
    expect(await maximumOf(clientTaskB)).toBe(MAXIMUM);
  });

  it("task to task: a member's grant on one task does not reach another task", async () => {
    const mine = await planned(planner);
    const theirs = await planned(planner);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(
        tx,
        taskScoped,
        'decide',
        { kind: 'record', id: mine.taskId },
        false,
        'billing',
      );
    });
    expect(codeOf(await topUp(taskScoped, theirs.taskId, SMALL, MAXIMUM))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(await maximumOf(theirs.taskId)).toBe(MAXIMUM);
    appliedDetail(await topUp(taskScoped, mine.taskId, SMALL, MAXIMUM), 'budget.top_up');
    expect(await maximumOf(mine.taskId)).toBe(MAXIMUM + SMALL);
  });

  it('Sol proof, criterion 3: the client-isolation actor has a task share but no business membership', async () => {
    const memberships = await rows<{ readonly id: string }>(
      s,
      `select id from public.memberships
        where business_id = $1 and person_id = $2 and active`,
      [s.business, clientA.personId],
    );
    const shares = await rows<{ readonly id: string }>(
      s,
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'read' and scope_kind = 'record'
          and revoked_at is null`,
      [s.business, clientA.personId],
    );
    expect({ memberships: memberships.length, taskShares: shares.length }).toStrictEqual({
      memberships: 0,
      taskShares: 1,
    });
  });

  it('Sol proof, criterion 3: two external clients each hold one distinct task share in this business', async () => {
    const clients = await rows<{ readonly person_id: string; readonly task_id: string }>(
      s,
      `select g.subject_id as person_id, g.scope_id as task_id from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.collection = 'task'
          and g.action = 'read' and g.scope_kind = 'record' and g.revoked_at is null
          and not exists(select 1 from public.memberships m
            where m.business_id = g.business_id and m.person_id = g.subject_id and m.active)`,
      [s.business],
    );
    expect(new Set(clients.map((client) => client.person_id)).size).toBe(2);
    expect(new Set(clients.map((client) => client.task_id)).size).toBe(2);
    expect(clients).toHaveLength(2);
  });
});
