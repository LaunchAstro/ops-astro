// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation holds its recipient's decide grants before its runtime locks,
// so a revocation of one of them waits for it. A grant issued after that hold
// is not held: a revocation of it would not wait. The recipient check under
// the locks therefore rests only on held grants, and so does the decider's own
// re-check: a decision called on the runtime directly, outside the command
// entry's access lock, is held the same way. Driven on separate backends:
// escalate is paused after its grant hold, the recipient is granted decide
// across the business through access.grant, escalate runs on through its
// recipient check, the grant is revoked through access.revoke, and escalate
// resumes. A rolled-back escalation is retried once, as the command entry does.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isRetryableViolation } from '../../packages/core-commands/src/commands/register-store.ts';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { afterFirstGrantHold, letDeciderEndAccess } from './escalation-access-end-harness.ts';
import {
  appliedDetail,
  asPerson,
  barrier,
  createTask,
  openSchedules,
  propose,
  racer,
  rows,
  waitPast,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/escalation-recipient-grant-issued-late: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('escalation_late', 1_000_000);
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
  note: `${decision} before the late grant`,
});

/** A gate at the revision bound: two rounds of changes used. */
async function atTheBound(): Promise<Detail> {
  const taskId = await createTask(s, `escalate late grant ${randomUUID()}`);
  const v1 = await propose(s, taskId);
  appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
  const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
  appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
  return await propose(s, taskId, { lineageId: String(v1['lineageId']) });
}

interface Stop {
  readonly at: (sql: string, parameters: readonly unknown[] | undefined) => boolean;
  readonly reached: ReturnType<typeof barrier>;
  readonly resume: ReturnType<typeof barrier>;
}

const stopAt = (at: Stop['at']): Stop => ({ at, reached: barrier(), resume: barrier() });

/** Each stop pauses the escalation once, just after the first statement it matches. */
function stopping(tx: TenantQuery, stops: readonly Stop[]): TenantQuery {
  const passed = new Set<Stop>();
  return {
    businessId: tx.businessId,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      const answer = await tx.query<Row>(sql, parameters);
      const stop = stops.find((one) => !passed.has(one) && one.at(sql, parameters));
      if (stop !== undefined) {
        passed.add(stop);
        stop.reached.release();
        await stop.resume.held;
      }
      return answer;
    },
  };
}

/** Decide the gate as `decider` on `database`, stopping where `stops` say. */
async function decideAs(
  database: Database,
  version: Detail,
  decider: Member,
  decision: { readonly decision: 'escalate' | 'request_changes'; readonly recipient?: Member },
  stops: Stop[],
) {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key in the fixture');
  const decided = await database.withBusiness(
    s.business,
    async (tx) =>
      await decide(stopping(tx, stops), {
        gateId: String(version['gateId']),
        versionId: String(version['versionId']),
        decidedByPersonId: decider.personId,
        decidedByActorId: decider.actorId,
        subjects: [
          { kind: 'person', id: decider.personId },
          { kind: 'actor', id: decider.actorId },
        ],
        collection: 'task',
        decision: decision.decision,
        note: `${decision.decision} under a late grant`,
        signingKey,
        capId: s.capId,
        ...(decision.recipient === undefined
          ? {}
          : { recipientPersonId: decision.recipient.personId }),
      }),
  );
  return decided.ok ? 'applied' : decided.refusal.code;
}

/** Escalate to `recipient` on `database`, stopping where `stops` say. */
async function escalate(database: Database, version: Detail, recipient: Member, stops: Stop[]) {
  return await decideAs(database, version, s.decider, { decision: 'escalate', recipient }, stops);
}

/** Just after the re-check under the locks reads which covering grants are live at its instant. */
const liveAtLockedInstant: Stop['at'] = (sql) =>
  sql.includes('id = any($2::uuid[])') && sql.includes('expires_at > $3::timestamptz');

/**
 * The last of the recipient checks under the locks: whether the task is theirs,
 * the first assignee read (`assignedPeople`, which names no person) after the
 * re-check's read of the recipient's active actor.
 */
function assignmentRead(personId: string): Stop['at'] {
  let actorRead = false;
  return (sql, parameters) => {
    if (sql.includes("kind = 'person' and active") && parameters?.[1] === personId)
      actorRead = true;
    return actorRead && sql.includes('r.uuid_2::text as person');
  };
}

/** A command on a backend of its own, closed once it settles. */
async function elsewhere(body: Body): Promise<Detail> {
  const database = racer(s);
  try {
    return appliedDetail(await asPerson(s, body, database), String(body['command']));
  } finally {
    await database.close();
  }
}

/** Who the gate is escalated to, and its state, read fresh. */
async function gateNow(version: Detail) {
  const [gate] = await rows<{ readonly to: string | null; readonly state: string }>(
    s,
    `select escalated_to_person_id as "to", state from public.gates
      where business_id = $1 and id = $2`,
    [s.business, version['gateId']],
  );
  return gate;
}

/** The escalation's answer, retried once on a rolled-back schedule as the command entry does. */
async function retriedOnce(first: Promise<string>, version: Detail, recipient: Member) {
  try {
    return await first;
  } catch (cause) {
    if (!isRetryableViolation(cause)) throw cause;
    return await escalate(s.db.app, version, recipient, []);
  }
}

describe.skipIf(serverUrl === undefined)('an escalation rests on held grants only', () => {
  it('never escalates to a recipient whose decide grant was issued after the hold and revoked before the write', async () => {
    const version = await atTheBound();
    const recipient = await enrol(s.db.app, s.business, `late-recipient-${randomUUID()}`);
    const afterHold = stopAt((sql) => afterFirstGrantHold.at(sql));
    const afterCheck = stopAt(assignmentRead(recipient.personId));
    const escalating = racer(s);
    const first = escalate(escalating, version, recipient, [afterHold, afterCheck]).finally(
      async () => {
        await escalating.close();
      },
    );
    first.catch(() => null);
    await afterHold.reached.held;

    const granted = await elsewhere({
      command: 'access.grant',
      operationId: randomUUID(),
      holderId: recipient.personId,
      collection: 'task',
      action: 'decide',
    });
    const grantId = granted['grantId'];
    afterHold.resume.release();
    await Promise.race([afterCheck.reached.held, first.catch(() => null)]);

    await elsewhere({ command: 'access.revoke', operationId: randomUUID(), grantId });
    afterCheck.resume.release();
    const escalation = await retriedOnce(first, version, recipient);
    expect({ escalation, gate: await gateNow(version) }).toEqual({
      escalation: 'SCOPE_NOT_GRANTED',
      gate: { to: null, state: 'pending' },
    });
  });
});

/** A decide grant on one task for `decider`, ending three seconds from now on the database clock. */
async function shortLivedDecide(decider: Member, taskId: string): Promise<string> {
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const [clock] = await tx.query<{ readonly at: Date }>(
      `select clock_timestamp() + interval '3 seconds' as at`,
    );
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: decider.personId },
      scope: { kind: 'record', id: taskId },
      collection: 'task',
      action: 'decide',
      expiresAt: clock?.at ?? null,
      parentGrantId: null,
      grantedByActorId: s.decider.actorId,
    });
    if (!issued.ok) throw new Error(`the short-lived grant was refused ${issued.refusal.code}`);
    return issued.value;
  });
}

/** The decision's answer, retried once on a rolled-back schedule as the command entry does. */
async function decidedOnce(first: Promise<string>, version: Detail, decider: Member) {
  try {
    return await first;
  } catch (cause) {
    if (!isRetryableViolation(cause)) throw cause;
    return await decideAs(s.db.app, version, decider, { decision: 'request_changes' }, []);
  }
}

describe.skipIf(serverUrl === undefined)('a decision rests on held grants only', () => {
  it('never records a decision resting on a decide grant issued after the hold and revoked before the write', async () => {
    const taskId = await createTask(s, `decide late grant ${randomUUID()}`);
    const version = await propose(s, taskId);
    const decider = await enrol(s.db.app, s.business, `late-decider-${randomUUID()}`);
    const shortLived = await shortLivedDecide(decider, taskId);
    const afterHold = stopAt((sql) => afterFirstGrantHold.at(sql));
    const afterCheck = stopAt(liveAtLockedInstant);
    const deciding = racer(s);
    const first = decideAs(deciding, version, decider, { decision: 'request_changes' }, [
      afterHold,
      afterCheck,
    ]).finally(async () => {
      await deciding.close();
    });
    first.catch(() => null);
    await afterHold.reached.held;

    const granted = await elsewhere({
      command: 'access.grant',
      operationId: randomUUID(),
      holderId: decider.personId,
      collection: 'task',
      action: 'decide',
    });
    await waitPast(s, 'select expires_at from public.grants where id = $1', shortLived);
    afterHold.resume.release();
    await Promise.race([afterCheck.reached.held, first.catch(() => null)]);

    await elsewhere({
      command: 'access.revoke',
      operationId: randomUUID(),
      grantId: granted['grantId'],
    });
    afterCheck.resume.release();
    const decided = await decidedOnce(first, version, decider);
    expect({ decided, gate: await gateNow(version) }).toEqual({
      decided: 'SCOPE_NOT_GRANTED',
      gate: { to: null, state: 'pending' },
    });
  });
});
