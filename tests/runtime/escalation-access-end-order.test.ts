// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation and `access.end` of its recipient take their locks in one
// order, so neither closes a cycle through the other. `access.end` locks the
// person's live grants `for update` in one id-ordered statement, then the
// runtime set, then updates their person actor. An escalation holds the
// decider's and the recipient's grants `for share` before its runtime set.
// Each case races the two on separate backends and reads the server's deadlock
// counter, since the command entry retries a 40P01 once and its outcome alone
// would hide one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asPerson,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import {
  afterFirstGrantHold,
  beforeTheRuntimeSet,
  letDeciderEndAccess,
  raceAccessEnd,
} from './escalation-access-end-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/escalation-access-end-order: DATABASE_URL is unset, so nothing below ran.');
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('escalation_end_order', 1_000_000);
  await letDeciderEndAccess(s);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

const decideBody = (version: Detail, decision: string): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} before the escalation`,
});

/** A gate at the revision bound: two rounds of changes used. */
async function atTheBound(): Promise<Detail> {
  const taskId = await createTask(s, `escalate order ${randomUUID()}`);
  const v1 = await propose(s, taskId);
  appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
  const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
  appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
  return await propose(s, taskId, { lineageId: String(v1['lineageId']) });
}

/**
 * N1's recipient: a decide grant `parent` the decider's own decide grant
 * descends from, and a task grant of theirs ordered below `parent` by id.
 * Grants take random ids, so one is issued until the order holds.
 */
async function grantorOfTheDecider(): Promise<Member> {
  const recipient = await enrol(s.db.app, s.business, `end-order-grantor-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    const parent = await grantTo(tx, recipient, 'decide', undefined, true);
    let below = false;
    for (let attempt = 0; attempt < 40 && !below; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- one grant at a time until one sorts below
      below = (await grantTo(tx, recipient, 'read')) < parent;
    }
    if (!below) throw new Error('no grant of the recipient sorted below their parent grant');
    const child = await issueGrant(tx, [{ kind: 'person', id: recipient.personId }], {
      subject: { kind: 'person', id: s.decider.personId },
      scope: WHOLE_BUSINESS,
      collection: 'task',
      action: 'decide',
      canDelegate: false,
      parentGrantId: parent,
      grantedByActorId: recipient.actorId,
    });
    if (!child.ok) throw new Error(`the child grant was refused ${child.refusal.code}`);
  });
  return recipient;
}

/**
 * N2's recipient: live agent work under the business's cap, on a delegation
 * they gave as its approver, and no live grant in the task collection. Their
 * grants end on the admin connection: `grant.revoke` would classify the work
 * with the grant, so no command leaves this state, which is the only one in
 * which `access.end` reaches the runtime set without first meeting a grant
 * the escalation holds.
 */
async function approverOfLiveWork(): Promise<Member> {
  const recipient = await enrol(s.db.app, s.business, `end-order-approver-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'comment', 'write', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's rows
      await grantTo(tx, recipient, action);
    }
  });
  const taskId = await createTask(s, `live work ${randomUUID()}`);
  const proposal = await propose(s, taskId, { purpose: freshPurpose() });
  const approval = await executeCommand(
    s.db.app,
    s.business,
    recipient.presented,
    'api',
    approveBody(proposal) as never,
  );
  await pickup(s, appliedDetail(approval, 'approve as the recipient')['reservationId']);
  await s.db.admin.execute(
    `update public.grants set revoked_at = now()
      where business_id = $1 and subject_kind = 'person' and subject_id = $2`,
    [s.business, recipient.personId] as never,
  );
  return recipient;
}

describe.skipIf(serverUrl === undefined)("an escalation and its recipient's access.end", () => {
  it("N1: holds the decider's and the recipient's grants in one id order, so access.end waits and nothing deadlocks", async () => {
    const recipient = await grantorOfTheDecider();
    const raced = await raceAccessEnd(
      s,
      await atTheBound(),
      recipient,
      afterFirstGrantHold,
      'grants',
    );
    expect(raced).toEqual({
      parked: true,
      escalation: 'applied',
      accessEnd: 'applied',
      deadlocks: 0,
    });
  });

  it("N2: takes no lock on the recipient's actor, so access.end's actor update after its runtime set closes no cycle", async () => {
    const recipient = await approverOfLiveWork();
    const raced = await raceAccessEnd(
      s,
      await atTheBound(),
      recipient,
      beforeTheRuntimeSet,
      'actors',
    );
    expect(raced).toEqual({
      parked: false,
      escalation: 'SCOPE_NOT_GRANTED',
      accessEnd: 'applied',
      deadlocks: 0,
    });
  });
});
