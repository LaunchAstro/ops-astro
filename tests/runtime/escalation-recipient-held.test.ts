// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation names a recipient who can decide the gate when it commits.
// The recipient's decide grants are what the check rests on, so they are held
// until the escalation commits: a revocation, or the recipient's access.end
// (which locks their grants before it deactivates their actor), that comes
// second waits for it, rather than committing between the check and the
// write. Driven on separate backends: escalate is paused, the grant is revoked
// (or access.end runs through its command entry) on another connection, and
// escalate is resumed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  beforeTheRuntimeSet,
  letDeciderEndAccess,
  parkedOn,
  raceAccessEnd,
} from './escalation-access-end-harness.ts';
import {
  appliedDetail,
  asPerson,
  barrier,
  createTask,
  openSchedules,
  propose,
  racer,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/escalation-recipient-held: DATABASE_URL is unset, so nothing below ran.');
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('escalation_held', 1_000_000);
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
  note: `${decision} before the held escalation`,
});

/** A gate at the revision bound: two rounds of changes used. */
async function atTheBound(): Promise<Detail> {
  const taskId = await createTask(s, `escalate held ${randomUUID()}`);
  const v1 = await propose(s, taskId);
  appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
  const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
  appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
  return await propose(s, taskId, { lineageId: String(v1['lineageId']) });
}

/** A person holding decide across the business, and the grant that gives it. */
async function recipientWithDecide(): Promise<{ member: Member; grantId: string }> {
  const member = await enrol(s.db.app, s.business, `held-recipient-${randomUUID()}`);
  const grantId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, member, 'decide'),
  );
  return { member, grantId };
}

/**
 * The last of escalate's reads of its recipient under the locks
 * (`recheckRecipient`: actor, grant, then assignment), after both the actor
 * and the grant were checked: the first assignee read (`assignedPeople`, which
 * names no person) after the re-check's read of the recipient's active actor.
 */
function recipientRead(personId: string) {
  let actorRead = false;
  return (sql: string, parameters: readonly unknown[] | undefined): boolean => {
    if (sql.includes("kind = 'person' and active") && parameters?.[1] === personId)
      actorRead = true;
    return actorRead && sql.includes('join public.delegations d');
  };
}

/** Escalate the gate to `recipient` in one transaction, paused just after its recipient checks. */
async function escalatePaused(
  version: Detail,
  recipient: Member,
  pause: { readonly reached: () => void; readonly held: Promise<void> },
) {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key in the fixture');
  let paused = false;
  const atRecipientRead = recipientRead(recipient.personId);
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const intercepted: TenantQuery = {
      businessId: tx.businessId,
      query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
        const answer = await tx.query<Row>(sql, parameters);
        if (!paused && atRecipientRead(sql, parameters)) {
          paused = true;
          pause.reached();
          await pause.held;
        }
        return answer;
      },
    };
    return await decide(intercepted, {
      gateId: String(version['gateId']),
      versionId: String(version['versionId']),
      decidedByPersonId: s.decider.personId,
      decidedByActorId: s.decider.actorId,
      subjects: [
        { kind: 'person', id: s.decider.personId },
        { kind: 'actor', id: s.decider.actorId },
      ],
      collection: 'task',
      decision: 'escalate',
      note: 'escalate at the bound',
      signingKey,
      capId: s.capId,
      recipientPersonId: recipient.personId,
    });
  });
}

/**
 * On another backend: one write, then a fresh read of who the gate is
 * escalated to. A write that waited for the escalation reads it committed.
 */
function writeElsewhere(write: string, id: string, gateId: unknown) {
  const other = racer(s);
  let finished = false;
  const done = other
    .withBusiness(s.business, async (tx) => {
      await tx.query(write, [tx.businessId, id]);
      const [gate] = await tx.query<{ readonly to: string | null }>(
        `select escalated_to_person_id as "to" from public.gates
          where business_id = $1 and id = $2`,
        [tx.businessId, gateId],
      );
      return gate?.to ?? null;
    })
    .finally(async () => {
      finished = true;
      await other.close();
    });
  return { done, finished: () => finished };
}

/** Escalate paused after its recipient checks; `write` on another backend; resume. */
async function raceEscalation(table: string, write: string, id: (r: Recipient) => string) {
  const version = await atTheBound();
  const recipient = await recipientWithDecide();
  const reached = barrier();
  const resume = barrier();
  const escalation = escalatePaused(version, recipient.member, {
    reached: reached.release,
    held: resume.held,
  });
  escalation.catch(() => null);
  await reached.held;
  const other = writeElsewhere(write, id(recipient), version['gateId']);
  const parked = await parkedOn(s, table, other.finished);
  resume.release();
  const escalated = await escalation;
  const writerSaw = await other.done;
  const [gate] = await rows<{ readonly to: string | null }>(
    s,
    `select escalated_to_person_id as "to" from public.gates where business_id = $1 and id = $2`,
    [s.business, version['gateId']],
  );
  return {
    recipient: recipient.member.personId,
    parked,
    escalation: escalated.ok ? 'applied' : escalated.refusal.code,
    escalatedTo: gate?.to ?? null,
    writerSaw,
  };
}

type Recipient = Awaited<ReturnType<typeof recipientWithDecide>>;

describe.skipIf(serverUrl === undefined)('an escalation holds its recipient', () => {
  it("parks the recipient's access.end on their decide grant until the escalation commits", async () => {
    const version = await atTheBound();
    const recipient = await recipientWithDecide();
    const raced = await raceAccessEnd(s, version, recipient.member, beforeTheRuntimeSet, 'grants');
    const [gate] = await rows<{ readonly to: string | null }>(
      s,
      `select escalated_to_person_id as "to" from public.gates where business_id = $1 and id = $2`,
      [s.business, version['gateId']],
    );
    expect({ ...raced, escalatedTo: gate?.to ?? null }).toEqual({
      parked: true,
      escalation: 'applied',
      accessEnd: 'applied',
      deadlocks: 0,
      escalatedTo: recipient.member.personId,
    });
  });

  it("parks the revocation of the recipient's decide grant until the escalation commits", async () => {
    const raced = await raceEscalation(
      'grants',
      `update public.grants set revoked_at = now() where business_id = $1 and id = $2`,
      (recipient) => recipient.grantId,
    );
    expect(raced).toEqual({
      recipient: raced.recipient,
      parked: true,
      escalation: 'applied',
      escalatedTo: raced.recipient,
      writerSaw: raced.recipient,
    });
  });
});
