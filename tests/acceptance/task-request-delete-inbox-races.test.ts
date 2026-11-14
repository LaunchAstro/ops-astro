// SPDX-License-Identifier: AGPL-3.0-only
//
// #2360 (Sol r1 coverage on #2418): a delete request's inbox item under a
// race and a revoked grant. An answer racing a new request leaves an open
// item exactly where a request is still open. A recipient whose grants are
// revoked after the request leaves an item no one can act on: the unattended
// list shows it while the request is open, and not once the request lapses.

import { describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { serverUrl } from './world.ts';
import { okay, openRequestWorld } from './task-request-delete-world.ts';

const w = openRequestWorld('task_request_delete_inbox_races_2360');
const h = w.harness;

/** Each request on the task, with whether it is open now and its open items. */
async function requestsAndItems(taskId: string) {
  return await h().world.db.admin.execute<{ readonly open: boolean; readonly items: number }>(
    `select (q.answer is null and q.expires_at > clock_timestamp()) as open,
            (select count(*)::int from public.inbox_items i
              where i.business_id = q.business_id and i.fact_kind = 'delete_request'
                and i.fact_id = q.id and i.work_state = 'open') as items
       from public.task_delete_requests q where q.task_id = $1 order by q.requested_at`,
    [taskId],
  );
}

async function unattendedOn(taskId: string): Promise<readonly Record<string, unknown>[]> {
  const read = await h().asPerson('inbox.unattended', {}, 'alpha', h().world.ada);
  expect(read.code, read.text).toBe('ok');
  return (read.body['unattended'] as Record<string, unknown>[]).filter(
    (item) => item['subjectRecordId'] === taskId && item['reason'] === 'delete_request',
  );
}

// eslint-disable-next-line max-lines-per-function -- one world, and the cases that share it
describe.skipIf(serverUrl === undefined)('a delete request’s inbox item, raced and revoked', () => {
  it('Keep racing a new request leaves an open item exactly on each open request', async () => {
    for (let round = 0; round < 4; round += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const task = await h().freshTask(`a task kept while asked again, round ${round}`);
      // oxlint-disable-next-line no-await-in-loop
      okay(await w.ask(task.id));
      // oxlint-disable-next-line no-await-in-loop
      const revision = await w.revisionOf(task.id);
      // oxlint-disable-next-line no-await-in-loop
      const requestId = await w.requestIdOf(task.id);
      // oxlint-disable-next-line no-await-in-loop
      const [kept, again] = await Promise.all([
        w.asAdaWide('task.decline_delete', {
          recordId: task.id,
          expectedRevision: revision,
          requestId,
        }),
        w.ask(task.id, 'asked again'),
      ]);
      expect([kept.code, again.code], 'each answers').not.toContain(undefined);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await requestsAndItems(task.id);
      expect(rows.length, `${kept.code} / ${again.code}`).toBeGreaterThan(0);
      for (const row of rows) expect(row.items, JSON.stringify(rows)).toBe(row.open ? 1 : 0);
    }
  });

  it('a recipient revoked after the request: unattended while open, gone once lapsed', async () => {
    const { noah } = h().world;
    const task = await h().freshTask('a task whose decider loses the grant, for the inbox');
    const grants: string[] = [];
    await h().world.db.app.withBusiness(h().world.alpha, async (tx) => {
      const scope = { kind: 'record' as const, id: task.id };
      for (const action of ['read', 'decide'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const id = await grantTo(tx, noah as unknown as Member, action, scope);
        grants.push(id);
      }
    });
    const asked = await h().asPerson(
      'task.request_delete',
      { recordId: task.id, expectedRevision: await w.revisionOf(task.id), reason: 'noah decides' },
      'alpha',
      h().world.ada,
    );
    okay(asked, 'Ada asks');
    const noahs = await h().world.db.admin.execute<{ readonly id: string }>(
      `select id from public.inbox_items where subject_record_id = $1 and recipient_person_id = $2
          and work_state = 'open'`,
      [task.id, noah.personId],
    );
    expect(noahs, 'Noah, a decide holder on the task, is told').toHaveLength(1);
    await h().world.db.app.withBusiness(h().world.alpha, async (tx) => {
      for (const id of grants) {
        // oxlint-disable-next-line no-await-in-loop
        if ((await revokeGrant(tx, id)) === null) throw new Error('revoke refused');
      }
    });
    const open = await unattendedOn(task.id);
    expect(open.map((item) => item['recipientPersonId'])).toContain(noah.personId);
    await h().world.db.admin.execute(
      `update public.task_delete_requests
          set requested_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        where task_id = $1`,
      [task.id],
    );
    expect(await unattendedOn(task.id), 'a lapsed request is not listed').toStrictEqual([]);
  });
});
