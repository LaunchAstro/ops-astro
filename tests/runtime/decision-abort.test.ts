// SPDX-License-Identifier: AGPL-3.0-only
//
// R2's remaining half: a reservation that fails after the decision is written
// aborts the whole transaction.
//
// `decide` writes the signed decision row and flips the gate to `approved`
// before it calls `reserve`. A refusal returned from `reserve` at that point
// is a refusal the caller can commit, and committing it leaves a gate marked
// approved that holds nothing — the half-approval the preflight in `decide`
// exists to prevent. The fix treats a refusal that late as a contradiction
// between two checks holding the same locks and throws, so the transaction is
// discarded rather than committed. This case forces that contradiction and
// reads back what survived it.
//
// The failure is arranged in the database, never in the source: the owner
// installs a `before insert` trigger on `public.task_envelopes` that shrinks
// the envelope opened for the magic maximum this proposal asks for. Preflight
// runs before that envelope exists, so it passes on the cap alone; `reserve`
// then re-reads the shrunken envelope under the locks and refuses
// `BUDGET_UNAVAILABLE`, after the decision row and the approved gate are
// written. The trigger rewrites a value rather than raising on purpose: a
// trigger that raised would abort the transaction by itself and would prove
// nothing about what `decide` does with a refusal it was handed.
//
// What this does not prove: nothing about which refusal code `reserve`
// produces, nothing about a shortfall preflight could have seen for itself,
// and nothing about concurrency — the lock-order and race proofs live in
// `tests/runtime/gate.test.ts`. The seam under test is the one between
// `reserve` refusing and `decide` returning.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import {
  buildFixture,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/decision-abort: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/**
 * The maximum this proposal asks for, and the value the arranged trigger fires
 * on. It is distinctive so the trigger can be written without interpolating an
 * identifier into DDL, and so no other proposal in any suite could trip it.
 */
const MAGIC_MAXIMUM_MINOR = 7_777;

const hour = (): Date => new Date(Date.now() + 3_600_000);

interface Proposed {
  readonly lineageId: string;
  readonly versionId: string;
  readonly gateId: string;
  readonly runId: string;
}

async function proposeOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  taskId: string,
): Promise<Proposed> {
  return await database.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: MAGIC_MAXIMUM_MINOR,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: hour(),
    });
    if (!result.ok)
      throw new Error(`propose refused ${result.refusal.code}: ${result.refusal.reason}`);
    return result.value;
  });
}

async function approveOn(database: FreshDatabase, fixture: RuntimeFixture, of: Proposed) {
  return await database.app.withBusiness(fixture.businessId, async (tx) =>
    decide(tx, {
      gateId: of.gateId,
      versionId: of.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    }),
  );
}

describe.skipIf(serverUrl === undefined)(
  'a decision whose reservation fails after the write',
  () => {
    let database: FreshDatabase;
    let fixture: RuntimeFixture;

    beforeAll(async () => {
      database = await createFreshDatabase({
        serverUrl: serverUrl as string,
        part: 'runtime_decision_abort',
      });
      fixture = await buildFixture(database.app, 'decision-abort');
    }, 120_000);

    afterAll(async () => {
      await database?.drop();
    });

    // R2. The decision row and the approved gate are already written when
    // `reserve` is reached, so a refusal from there cannot be an answer.
    it('R2: a reservation that fails after the decision is written aborts the transaction', async () => {
      const taskId = await newTask(database.app, fixture.businessId, fixture.decider);
      const proposed = await proposeOn(database, fixture, taskId);

      const before = await database.app.withBusiness(fixture.businessId, async (tx) => {
        const rows = await tx.query<{ readonly held: string; readonly actual: string }>(
          `select coalesce(sum(held_minor), 0)::text as held,
                coalesce(sum(actual_minor), 0)::text as actual
           from public.task_envelopes where business_id = $1`,
          [fixture.businessId],
        );
        return rows[0];
      });

      // Arranged as the owner, because the application role owns nothing and may
      // not create: the envelope this approval opens is shrunk below the hold it
      // is about to take, and only that envelope. Nothing raises here, so
      // `reserve` refuses in its own words rather than the server's.
      try {
        await database.admin.execute(
          `create function public.shrink_the_envelope_under_test() returns trigger
           language plpgsql as $fn$
         begin
           new.maximum_minor := 1;
           return new;
         end
         $fn$`,
        );
        await database.admin.execute(
          `create trigger shrink_the_envelope_under_test
           before insert on public.task_envelopes
           for each row when (new.maximum_minor = ${MAGIC_MAXIMUM_MINOR})
           execute function public.shrink_the_envelope_under_test()`,
        );

        // Not `{ ok: false }`: a committable refusal here is the half-approval.
        await expect(approveOn(database, fixture, proposed)).rejects.toThrow(
          /reserve refused BUDGET_UNAVAILABLE after the decision was written/u,
        );
      } finally {
        await database.admin.execute(
          `drop trigger if exists shrink_the_envelope_under_test on public.task_envelopes`,
        );
        await database.admin.execute(
          `drop function if exists public.shrink_the_envelope_under_test()`,
        );
      }

      // A new transaction, so what it reads is what committed rather than what
      // the aborted one could still see.
      await database.app.withBusiness(fixture.businessId, async (tx) => {
        const state = await tx.query<{
          readonly decisions: string;
          readonly gate_state: string;
          readonly reservations: string;
          readonly attempts: string;
          readonly envelopes: string;
        }>(
          `select (select count(*)::text from public.gate_decisions
                  where business_id = $1 and gate_id = $2) as decisions,
                (select state from public.gates
                  where business_id = $1 and id = $2) as gate_state,
                (select count(*)::text from public.reservations
                  where business_id = $1 and version_id = $3) as reservations,
                (select count(*)::text from public.attempts
                  where business_id = $1 and version_id = $3) as attempts,
                (select count(*)::text from public.task_envelopes
                  where business_id = $1 and task_id = $4) as envelopes`,
          [fixture.businessId, proposed.gateId, proposed.versionId, taskId],
        );
        // No envelope row was created at all, so there is no envelope total to
        // compare: the insert the trigger rewrote was rolled back with the rest.
        expect(state[0]).toEqual({
          decisions: '0',
          gate_state: 'pending',
          reservations: '0',
          attempts: '0',
          envelopes: '0',
        });

        // And the business's own totals are where they were.
        const after = await tx.query<{ readonly held: string; readonly actual: string }>(
          `select coalesce(sum(held_minor), 0)::text as held,
                coalesce(sum(actual_minor), 0)::text as actual
           from public.task_envelopes where business_id = $1`,
          [fixture.businessId],
        );
        expect(after[0]).toEqual(before);
      });

      // The arrangement was the only thing standing in the way: with the trigger
      // gone the same gate still decides, which is what makes the abort above an
      // abort rather than a gate this fixture could never have approved.
      const approved = await approveOn(database, fixture, proposed);
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.heldMinor).toBe(MAGIC_MAXIMUM_MINOR);
    });
  },
);
