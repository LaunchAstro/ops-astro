// SPDX-License-Identifier: AGPL-3.0-only
//
// Escalation names a recipient who can decide the gate. A person's sign-in
// acts through their one active person actor, so a grant left on a
// deactivated actor of theirs authorises nothing they can use, and escalating
// to them on the strength of it would park the gate with nobody able to
// decide it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { insertActor } from '../identity/fixture.ts';
import { enrol, type Member } from '../commands/fixture.ts';
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
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/escalation-recipient-active-actor: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('escalation_active_actor', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the inactive actor escalation case`,
  ...extra,
});

/** A gate at the revision bound: two rounds of changes used. */
async function atTheBound(): Promise<Detail> {
  const taskId = await createTask(s, `escalate inactive actor ${randomUUID()}`);
  const v1 = await propose(s, taskId);
  appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
  const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
  appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
  return await propose(s, taskId, { lineageId: String(v1['lineageId']) });
}

/**
 * A person whose only business-wide read and decide grants sit on an actor
 * since deactivated, now acting through a new active actor with no decide.
 */
async function decideOnlyOnARetiredActor(): Promise<Member> {
  const member = await enrol(s.db.app, s.business, `retired-decider-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: member.actorId },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action,
        parentGrantId: null,
        grantedByActorId: s.decider.actorId,
      });
      if (!issued.ok) throw new Error(`grant refused ${issued.refusal.code}`);
    }
    await tx.query(
      `update public.actors set active = false, deactivated_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, member.actorId],
    );
    await insertActor(tx, member.personId);
  });
  return member;
}

async function gateOf(gateId: unknown) {
  return (
    await rows<Record<string, unknown>>(
      s,
      `select g.state, (g.escalated_at is not null) as escalated, g.escalated_to_person_id as "to",
              (select count(*)::int from public.gate_decisions d
                where d.business_id = g.business_id and d.gate_id = g.id) as decisions
         from public.gates g where g.business_id = $1 and g.id = $2`,
      [s.business, gateId],
    )
  )[0];
}

describe.skipIf(serverUrl === undefined)('escalation counts only the active actor', () => {
  it('refuses a recipient whose only business-wide decide is on a deactivated actor, and the gate stays pending', async () => {
    const v3 = await atTheBound();
    const recipient = await decideOnlyOnARetiredActor();
    const refused = await asPerson(
      s,
      decideBody(v3, 'escalate', { recipientPersonId: recipient.personId }),
    );
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(await gateOf(v3['gateId'])).toEqual({
      state: 'pending',
      escalated: false,
      to: null,
      decisions: 0,
    });
  });
});
