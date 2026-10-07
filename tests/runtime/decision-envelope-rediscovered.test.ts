// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision locks the cap its task's envelope draws on, or the cap it names
// when the task has no envelope yet. An envelope another approval opens while
// this one waits is an accounting parent it never locked, on a cap it never
// checked, so it must roll back and discover again, and then meet the
// envelope's own cap: CAP_BINDING_MISMATCH, with no decision and no hold.
// Driven on separate backends: decision B is paused just after its discovery
// found no envelope, gate A is approved on another connection and its
// envelope topped up, and B is resumed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isRetryableViolation } from '../../packages/core-commands/src/commands/register-store.ts';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  appliedDetail,
  approveBody,
  barrier,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  racer,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/decision-envelope-rediscovered: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
let capB: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('decision_envelope', 1_000_000);
  capB = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'second', 1000000, 'AUD')`,
      [tx.businessId, capB],
    );
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The task's open-envelope read: the decision's discovery of its accounting parent. */
const envelopeRead = (sql: string): boolean =>
  sql.includes('public.task_envelopes') && sql.includes("task_id = $2 and state = 'open'");

/** One decide transaction on cap B, paused after its first envelope read when `pause` is given. */
async function decideOnCapB(
  version: Detail,
  pause?: { readonly reached: () => void; readonly held: Promise<void> },
) {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key in the fixture');
  let paused = false;
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const intercepted: TenantQuery = {
      businessId: tx.businessId,
      query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
        const answer = await tx.query<Row>(sql, parameters);
        if (pause !== undefined && !paused && envelopeRead(sql)) {
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
      decision: 'approve',
      note: 'approve B on cap B',
      signingKey,
      capId: capB,
    });
  });
}

/** On another backend: gate A approved on cap A for 500, its envelope then topped up to 1000. */
async function approveAOnAnotherBackend(versionA: Detail, taskId: string): Promise<void> {
  const other = racer(s);
  try {
    const approved = await executeCommand(
      other,
      s.business,
      s.decider.presented,
      'api',
      approveBody(versionA) as never,
    );
    appliedDetail(approved, 'approve A on cap A');
    await other.withBusiness(s.business, async (tx) => {
      await tx.query(
        `update public.task_envelopes set maximum_minor = 1000
          where business_id = $1 and task_id = $2 and state = 'open'`,
        [tx.businessId, taskId],
      );
    });
  } finally {
    await other.close();
  }
}

type Decided = Awaited<ReturnType<typeof decideOnCapB>>;

const codeOf = (decided: Decided): string => (decided.ok ? 'applied' : decided.refusal.code);

/** As the command entry does: a rolled-back schedule is retried once in a fresh transaction. */
async function retriedOnce(
  first: Promise<Decided>,
  version: Detail,
): Promise<{ readonly rediscovered: boolean; readonly code: string }> {
  try {
    return { rediscovered: false, code: codeOf(await first) };
  } catch (cause) {
    if (!isRetryableViolation(cause)) throw cause;
    return { rediscovered: true, code: codeOf(await decideOnCapB(version)) };
  }
}

async function leftOn(version: Detail) {
  const [left] = await rows<{ decisions: number; holds: number; gate: string }>(
    s,
    `select (select count(*)::int from public.gate_decisions d
              where d.business_id = $1 and d.gate_id = $2) as decisions,
            (select count(*)::int from public.reservations r
              where r.business_id = $1 and r.version_id = $3) as holds,
            (select g.state from public.gates g where g.business_id = $1 and g.id = $2) as gate`,
    [s.business, version['gateId'], version['versionId']],
  );
  return left;
}

describe.skipIf(serverUrl === undefined)(
  'a decision rediscovers its envelope under the locks',
  () => {
    it('refuses CAP_BINDING_MISMATCH after rediscovery when another approval opened the envelope on another cap, with no decision or hold for B', async () => {
      const taskId = await createTask(s, `decision envelope ${randomUUID()}`);
      const versionA = await propose(s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
      const versionB = await propose(s, taskId, { maximumMinor: 500, purpose: freshPurpose() });

      const reached = barrier();
      const resume = barrier();
      const first = decideOnCapB(versionB, { reached: reached.release, held: resume.held });
      // Held so a rejection before the resume is not unhandled.
      first.catch(() => null);
      await reached.held;
      await approveAOnAnotherBackend(versionA, taskId);
      resume.release();

      expect(await retriedOnce(first, versionB)).toEqual({
        rediscovered: true,
        code: 'CAP_BINDING_MISMATCH',
      });
      expect(await leftOn(versionB)).toEqual({ decisions: 0, holds: 0, gate: 'pending' });
    });
  },
);
