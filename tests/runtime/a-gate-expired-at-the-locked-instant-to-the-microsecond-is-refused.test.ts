// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision judges its gate's deadline at the locked instant, read from the
// database as text so it keeps its microseconds. Bound back into SQL as a
// timestamptz parameter, the driver turns it into a JavaScript Date first,
// which keeps milliseconds only, so a gate that expired within the last
// millisecond before the instant read as live. The decision's clock read is
// answered here with the gate's own deadline, to the microsecond: at that
// instant the gate has expired, and the decision is refused GATE_EXPIRED.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createTask, openSchedules, propose, rows, type Schedules } from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('gate_microsecond', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The decision's locked-instant read answered with `instant` instead of the clock. */
function lockedAt(tx: TenantQuery, instant: string): TenantQuery {
  return {
    businessId: tx.businessId,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) =>
      sql.includes('select clock_timestamp()::text as at')
        ? ([{ at: instant }] as unknown as readonly Row[])
        : await tx.query<Row>(sql, parameters),
  };
}

it('a gate whose deadline is the locked instant to the microsecond is refused as expired', async () => {
  const taskId = await createTask(s, `microsecond deadline ${randomUUID()}`);
  const version = await propose(s, taskId);
  const [deadline] = await rows<{ readonly at: string }>(
    s,
    `update public.gates
        set expires_at = date_trunc('second', clock_timestamp()) + interval '1 hour 0.123456 second'
      where business_id = $1 and id = $2
      returning expires_at::text as at`,
    [s.business, version['gateId']],
  );
  const signingKey = gateSigningKey();
  if (deadline === undefined || signingKey === undefined) throw new Error('fixture incomplete');
  const decided = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await decide(lockedAt(tx, deadline.at), {
        gateId: String(version['gateId']),
        versionId: String(version['versionId']),
        decidedByPersonId: s.decider.personId,
        decidedByActorId: s.decider.actorId,
        subjects: [
          { kind: 'person', id: s.decider.personId },
          { kind: 'actor', id: s.decider.actorId },
        ],
        collection: 'task',
        decision: 'request_changes',
        note: 'decided at the deadline',
        signingKey,
        capId: s.capId,
      }),
  );
  expect(decided.ok ? 'applied' : decided.refusal.code).toBe('GATE_EXPIRED');
});
