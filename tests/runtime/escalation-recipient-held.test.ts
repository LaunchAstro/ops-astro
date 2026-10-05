// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation names a recipient who can decide the gate when it commits.
// The recipient's active person actor and their decide grants are what the
// check rests on, so they are held until the escalation commits: a
// deactivation or a revocation that comes second waits for it, rather than
// committing between the check and the write. Driven on separate backends:
// escalate is paused just after its recipient checks, the actor is deactivated
// (or the grant revoked) on another connection, and escalate is resumed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  barrier,
  createTask,
  openSchedules,
  propose,
  racer,
  rows,
  scalar,
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
 * and the grant were checked.
 */
const recipientRead = (sql: string, parameters: readonly unknown[] | undefined, personId: string) =>
  sql.includes('from public.records r') &&
  sql.includes('d.delegate_person_id = $3') &&
  parameters?.[2] === personId;

/** Escalate the gate to `recipient` in one transaction, paused just after its recipient checks. */
async function escalatePaused(
  version: Detail,
  recipient: Member,
  pause: { readonly reached: () => void; readonly held: Promise<void> },
) {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key in the fixture');
  let paused = false;
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const intercepted: TenantQuery = {
      businessId: tx.businessId,
      query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
        const answer = await tx.query<Row>(sql, parameters);
        if (!paused && recipientRead(sql, parameters, recipient.personId)) {
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

/** Whether a backend parks on a row lock in `table` before `finished` says the write went through. */
async function parkedOn(table: string, finished: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (finished()) return false;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    const parked = await scalar(
      s,
      `select count(distinct a.pid)::text as n
         from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and l.locktype = 'tuple'
         join pg_class c on c.oid = l.relation
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and c.relname = $1`,
      [table],
    );
    if (parked > 0) return true;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
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
  const parked = await parkedOn(table, other.finished);
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
  it("parks the recipient's deactivation until the escalation naming their active actor commits", async () => {
    const raced = await raceEscalation(
      'actors',
      `update public.actors set active = false, deactivated_at = now()
        where business_id = $1 and id = $2`,
      (recipient) => recipient.member.actorId,
    );
    expect(raced).toEqual({
      recipient: raced.recipient,
      parked: true,
      escalation: 'applied',
      escalatedTo: raced.recipient,
      writerSaw: raced.recipient,
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
