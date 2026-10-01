// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-B1 review round 1, rs-6 (beside the p03-1 review proof,
// review-p03-unattended-escalated-decider.test.ts). An escalated gate is
// decided only with `task:decide` across the business (T3a). When the
// escalation's recipient keeps that grant, there is still a path to the
// decision, so the item is not listed as unattended, even with every other
// decider unable to sign in.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { readUnattended } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  appliedDetail,
  asPerson,
  createTask,
  openSchedules,
  propose,
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
  note: `${decision} in the rs-6 escalated case`,
  ...extra,
});

describe.skipIf(serverUrl === undefined)(
  'unattended on an escalated gate, business decide kept',
  () => {
    let s: Schedules;
    let holder: Member;

    beforeAll(async () => {
      s = await openSchedules('fixb1rs6', 1_000_000);
      holder = await enrol(s.db.app, s.business, 'escalation-holder');
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, holder, 'read');
        await grantTo(tx, holder, 'decide');
      });
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('an escalated decision whose recipient holds decide across the business is not unattended', async () => {
      const taskId = await createTask(s, `rs-6 ${randomUUID()}`);
      const v1 = await propose(s, taskId);
      appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
      const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
      appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
      const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
      appliedDetail(
        await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
        'escalate',
      );

      // The other business decider can no longer sign in: the holder is the one path.
      await s.db.admin.execute(
        `update public.person_logins set active = false, deactivated_at = now()
        where person_id = $1 and active`,
        [s.decider.personId],
      );

      const open = await rows<{ id: string }>(
        s,
        `select id from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_id = $2 and work_state = 'open'`,
        [s.business, v3['gateId']],
      );
      expect(open.length).toBeGreaterThan(0);
      const listed = await s.db.app.withBusiness(
        s.business,
        async (tx) => await readUnattended(tx, holder.personId),
      );
      expect(listed.filter((item) => open.some((row) => row.id === item.id))).toEqual([]);
    });
  },
);
