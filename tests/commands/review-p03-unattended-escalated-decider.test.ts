// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (REVIEW-MAIN-B1 p03-1). `unattended` counts a decision attended
// when a recipient holds `task:decide` at task scope, but an escalated gate is
// decided only at business scope (T3a). The only live recipient can no longer
// decide it, so no path reaches the decision, yet the list stays quiet.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { readUnattended } from '../../packages/core-records/src/index.ts';
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

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the p03-1 review proof`,
  ...extra,
});

describe.skipIf(serverUrl === undefined)('review p03-1 unattended on an escalated gate', () => {
  let s: Schedules;
  let holder: Member;
  let holderBusinessDecide = '';

  beforeAll(async () => {
    s = await openSchedules('rmb1p03_1', 1_000_000);
    holder = await enrol(s.db.app, s.business, 'escalation-holder');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, holder, 'read');
      holderBusinessDecide = await grantTo(tx, holder, 'decide');
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('an escalated decision whose only reachable recipient decides at task scope alone is unattended', async () => {
    const taskId = await createTask(s, `p03-1 ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
    const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
    const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: holder.personId })),
      'escalate',
    );

    // The holder keeps task-scope decide but loses decide across the business,
    // and the other business decider can no longer sign in.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, holder, 'decide', { kind: 'record', id: taskId });
      await revokeGrant(tx, holderBusinessDecide);
    });
    await s.db.admin.execute(
      `update public.person_logins set active = false, deactivated_at = now()
        where person_id = $1 and active`,
      [s.decider.personId],
    );

    // Nobody can decide the gate now: the holder is refused by the escalation rule.
    const tried = await executeCommand(
      s.db.app,
      s.business,
      holder.presented,
      'api',
      decideBody(v3, 'approve') as never,
    );
    expect(codeOf(tried)).not.toBe('applied');

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
    const ids = new Set(listed.map((item) => item.id));
    expect(
      open.every((item) => ids.has(item.id)),
      'p03-1 defect: unattended counts task-scope decide as a path to an escalated gate that only business-scope decide can decide, so a decision nobody can make reads as attended',
    ).toBe(true);
  });
});
