// SPDX-License-Identifier: AGPL-3.0-only
//
// W03: handback racing the classifier and a new proposal, and the stale-version
// handback, all through the production command entry.
//
// The ledger row asks to "race handback against classifier or a new proposal
// and detect deadlock, double release, stale successor or replacement
// mutation". `classifier-race.test.ts` races two classifiers through the
// runtime helpers; nothing raced a handback, and nothing went through the
// command adapters, which is where the runtime reviewer's F1 lives: `task.propose`
// locks its task in `prepare.ts` before the runtime takes the cap and the
// envelope, while `task.handback` takes the cap, the envelope and then the task.
//
// **Two-connection ordering.** A third connection holds a row the racers need.
// The first racer is started and seen parked on its named table, then the
// second, then the holder lets go; `schedules-harness.ts` says why that order
// is the server's. Nothing is slept through.
//
// The stale-version cases are the reviewer's F3 sequence, run sequentially:
// approve and pick up V1, propose V2 in the same lineage, then hand V1 back
// with and without a successor. T4: "Late or superseded lease handback cannot
// settle work", and a stale successor must not supersede V2.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  envelopeHeld,
  freshPurpose,
  handbackBody,
  holdRows,
  liveWork,
  openSchedules,
  propose,
  proposeBody,
  racer,
  reasonOf,
  revisionOf,
  rows,
  scalar,
  settle,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/schedules-w03: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/**
 * The raced hold. The envelope's ceiling is its first approved version's
 * maximum, so no second hold fits beside it; a double release would drive the
 * total below zero and the non-negative constraint would fault the second
 * writer, which these cases would see as a rejected racer.
 */
const HOLD = 2_000;

const cancelBody = (work: Work): Readonly<Record<string, unknown>> => ({
  command: 'task.cancel',
  operationId: randomUUID(),
  recordId: work.taskId,
  lineageId: work.proposal['lineageId'],
  reason: 'the client withdrew the request',
});

/**
 * The contract's answer is a named refusal the caller can act on (T4:
 * "Return LEASE_NOT_OWNED or LEASE_EXPIRED on the actual cause"), not a
 * fault. The durable state is asserted first, so a red here says which
 * half failed.
 */
function assertTypedRefusal(answer: PromiseSettledResult<CommandResult> | undefined): void {
  if (answer === undefined) throw new Error('no answer');
  expect(answer.status, `stale handback faulted: ${reasonOf(answer)}`).toBe('fulfilled');
  if (answer.status !== 'fulfilled') throw new Error('unreachable');
  expect(isCommandRefusal(answer.value), `answered ${codeOf(answer.value)}`).toBe(true);
}

describe.skipIf(serverUrl === undefined)(
  'W03: handback schedules through the command entry',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('w03', 100_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    async function envelopeIdOf(taskId: string): Promise<string> {
      const found = await rows<{ readonly id: string }>(
        s,
        `select id from public.task_envelopes where business_id = $1 and task_id = $2`,
        [s.business, taskId],
      );
      const id = found[0]?.id;
      if (id === undefined) throw new Error(`no envelope on ${taskId}`);
      return id;
    }

    async function reservation(
      id: unknown,
    ): Promise<{ readonly state: string; readonly cause: string | null }> {
      const found = await rows<{
        readonly state: string;
        readonly classified_cause: string | null;
      }>(
        s,
        `select state, classified_cause from public.reservations where business_id = $1 and id = $2`,
        [s.business, id],
      );
      return { state: found[0]?.state ?? 'missing', cause: found[0]?.classified_cause ?? null };
    }

    async function reports(leaseId: unknown, disposition: string): Promise<number> {
      return await scalar(
        s,
        `select count(*)::text as n from public.handback_reports
        where business_id = $1 and lease_id = $2 and disposition = $3`,
        [s.business, leaseId, disposition],
      );
    }

    async function lineageState(lineageId: unknown): Promise<string> {
      const found = await rows<{ readonly state: string }>(
        s,
        `select state from public.proposal_lineages where business_id = $1 and id = $2`,
        [s.business, lineageId],
      );
      return found[0]?.state ?? 'missing';
    }

    async function workOn(title: string): Promise<Work> {
      const work = await liveWork(s, title, HOLD);
      expect(await envelopeHeld(s, work.taskId)).toBe(HOLD);
      return work;
    }

    describe('handback versus the classifier (task.cancel)', () => {
      it('handback first: it settles, the cancellation classifies nothing twice, and the hold is released once', async () => {
        const work = await workOn('handback then cancel');
        const cancelRequest = cancelBody(work);
        const handbackDb = racer(s);
        const cancelDb = racer(s);
        const holder = await holdRows(s, 'budget_caps', [s.capId]);
        let outcomes: readonly PromiseSettledResult<CommandResult>[] = [];
        try {
          const handedBack = asAgent(
            s,
            handbackBody(work.picked),
            String(work.picked['credential']),
            handbackDb,
          );
          await awaitParked(s, 'budget_caps', 1);
          const cancelled = asPerson(s, cancelRequest, cancelDb);
          await awaitParked(s, 'budget_caps', 2);
          await holder.release();
          outcomes = await settle([handedBack, cancelled]);
        } finally {
          await holder.release().catch(() => undefined);
          await handbackDb.close();
          await cancelDb.close();
        }
        const [handback, cancel] = outcomes as [
          PromiseSettledResult<CommandResult>,
          PromiseSettledResult<CommandResult>,
        ];

        // No deadlock and no thrown fault on the handback, which went first.
        expect(handback.status, reasonOf(handback)).toBe('fulfilled');
        if (handback.status !== 'fulfilled') throw new Error('unreachable');
        expect(codeOf(handback.value)).toBe('applied');
        expect(await reports(work.picked['leaseId'], 'settled')).toBe(1);

        // The raced hold released exactly once.
        expect(await reservation(work.decision['reservationId'])).toStrictEqual({
          state: 'abandoned',
          cause: 'handback_completed',
        });
        expect(await envelopeHeld(s, work.taskId)).toBe(0);

        // The cancellation reached its lock set after the handback committed. It
        // must not release anything a second time. At 74d583c its rediscovery
        // under the locks finds the reservation gone and throws "roll back and
        // rediscover" (`recovery.ts`, `cancelAndClassify`), which the caller sees
        // as a fault; whether that should rediscover inside the operation is for
        // the runtime owner. Either way nothing of it may have committed, and the
        // same operation identity then completes it as cancelled.
        const firstCancel = cancelRequest;
        if (cancel.status === 'fulfilled' && codeOf(cancel.value) === 'applied') {
          expect(await lineageState(work.proposal['lineageId'])).toBe('cancelled');
        } else {
          expect(await lineageState(work.proposal['lineageId'])).toBe('live');
          const body = firstCancel;
          const retried = await asPerson(s, body);
          expect(
            codeOf(retried),
            `first cancel: ${cancel.status === 'fulfilled' ? codeOf(cancel.value) : reasonOf(cancel)}`,
          ).toBe('applied');
          expect(await lineageState(work.proposal['lineageId'])).toBe('cancelled');
        }
        expect(await envelopeHeld(s, work.taskId)).toBe(0);
      });

      it('cancellation first: it classifies the hold once, and the late handback settles nothing', async () => {
        const work = await workOn('cancel then handback');
        const handbackDb = racer(s);
        const cancelDb = racer(s);
        const holder = await holdRows(s, 'budget_caps', [s.capId]);
        let outcomes: readonly PromiseSettledResult<CommandResult>[] = [];
        try {
          const cancelled = asPerson(s, cancelBody(work), cancelDb);
          await awaitParked(s, 'budget_caps', 1);
          const handedBack = asAgent(
            s,
            handbackBody(work.picked),
            String(work.picked['credential']),
            handbackDb,
          );
          await awaitParked(s, 'budget_caps', 2);
          await holder.release();
          outcomes = await settle([cancelled, handedBack]);
        } finally {
          await holder.release().catch(() => undefined);
          await handbackDb.close();
          await cancelDb.close();
        }
        const [cancel, handback] = outcomes as [
          PromiseSettledResult<CommandResult>,
          PromiseSettledResult<CommandResult>,
        ];

        expect(cancel.status, reasonOf(cancel)).toBe('fulfilled');
        if (cancel.status !== 'fulfilled') throw new Error('unreachable');
        expect(codeOf(cancel.value)).toBe('applied');
        expect(await lineageState(work.proposal['lineageId'])).toBe('cancelled');

        // The handback met a released lease under its locks: a refusal, never a
        // settlement, and no deadlock or fault.
        expect(handback.status, reasonOf(handback)).toBe('fulfilled');
        if (handback.status !== 'fulfilled') throw new Error('unreachable');
        expect(isCommandRefusal(handback.value)).toBe(true);
        expect(await reports(work.picked['leaseId'], 'settled')).toBe(0);

        expect(await reservation(work.decision['reservationId'])).toStrictEqual({
          state: 'abandoned',
          cause: 'lineage_cancelled',
        });
        expect(await envelopeHeld(s, work.taskId)).toBe(0);
      });
    });

    describe('handback versus a new proposal (runtime review F1)', () => {
      // The reviewer's schedule: the proposal holds the task and wants the cap;
      // the handback holds the cap and wants the task. The holder keeps the
      // envelope, so the handback parks on it holding the cap; the proposal is
      // then started, takes the task in the adapter and parks on the cap. When
      // the holder lets go the handback asks for the task. The contract outcome
      // is that both complete: no deadlock victim, one settlement, one new
      // pending proposal.
      it('both complete, in either class order, with no deadlock victim', async () => {
        const work = await workOn('handback against a new proposal');
        const envelopeId = await envelopeIdOf(work.taskId);
        const handbackDb = racer(s);
        const proposeDb = racer(s);
        const body = proposeBody(work.taskId, await revisionOf(s, work.taskId), {
          maximumMinor: 1_000,
          purpose: freshPurpose(),
        });
        const holder = await holdRows(s, 'task_envelopes', [envelopeId]);
        let outcomes: readonly PromiseSettledResult<CommandResult>[] = [];
        try {
          const handedBack = asAgent(
            s,
            handbackBody(work.picked),
            String(work.picked['credential']),
            handbackDb,
          );
          await awaitParked(s, 'task_envelopes', 1);
          const proposed = asPerson(s, body, proposeDb);
          await awaitParked(s, 'budget_caps', 1);
          await holder.release();
          outcomes = await settle([handedBack, proposed]);
        } finally {
          await holder.release().catch(() => undefined);
          await handbackDb.close();
          await proposeDb.close();
        }
        const [handback, proposal] = outcomes as [
          PromiseSettledResult<CommandResult>,
          PromiseSettledResult<CommandResult>,
        ];

        expect(handback.status, `handback: ${reasonOf(handback)}`).toBe('fulfilled');
        expect(proposal.status, `task.propose: ${reasonOf(proposal)}`).toBe('fulfilled');
        if (handback.status !== 'fulfilled' || proposal.status !== 'fulfilled') {
          throw new Error('unreachable');
        }
        expect(codeOf(handback.value)).toBe('applied');
        expect(codeOf(proposal.value)).toBe('applied');
        expect(await reports(work.picked['leaseId'], 'settled')).toBe(1);
        expect(await envelopeHeld(s, work.taskId)).toBe(0);
        const gate = await rows<{ readonly state: string }>(
          s,
          `select state from public.gates where business_id = $1 and id = $2`,
          [s.business, appliedDetail(proposal.value, 'task.propose')['gateId']],
        );
        expect(gate[0]?.state).toBe('pending');
      });
    });

    describe('stale-version handback (runtime review F3)', () => {
      /** Approve and pick up V1, then a person proposes V2 in the same lineage. */
      async function superseded(title: string): Promise<{
        readonly work: Work;
        readonly v2: Detail;
        readonly heldBefore: number;
        readonly versionsBefore: number;
      }> {
        const work = await liveWork(s, title, HOLD);
        const v2 = await propose(s, work.taskId, {
          lineageId: String(work.proposal['lineageId']),
          maximumMinor: HOLD,
          purpose: freshPurpose(),
        });
        expect(v2['lineageId']).toBe(work.proposal['lineageId']);
        return {
          work,
          v2,
          heldBefore: await envelopeHeld(s, work.taskId),
          versionsBefore: await versionsOn(work.proposal['lineageId']),
        };
      }

      async function versionsOn(lineageId: unknown): Promise<number> {
        return await scalar(
          s,
          `select count(*)::text as n from public.proposal_versions where business_id = $1 and lineage_id = $2`,
          [s.business, lineageId],
        );
      }

      async function assertV2Current(state: Awaited<ReturnType<typeof superseded>>): Promise<void> {
        const lineageId = state.work.proposal['lineageId'];
        const current = await rows<{ readonly id: string }>(
          s,
          `select id from public.proposal_versions
          where business_id = $1 and lineage_id = $2 and superseded_at is null`,
          [s.business, lineageId],
        );
        expect(current.map((row) => row.id)).toStrictEqual([state.v2['versionId']]);
        const gate = await rows<{ readonly state: string }>(
          s,
          `select state from public.gates where business_id = $1 and id = $2`,
          [s.business, state.v2['gateId']],
        );
        expect(gate[0]?.state).toBe('pending');
        // No successor: the lineage has exactly the two versions it had.
        expect(await versionsOn(lineageId)).toBe(state.versionsBefore);
        expect(await envelopeHeld(s, state.work.taskId)).toBe(state.heldBefore);
        // No settlement of superseded work.
        expect(await reports(state.work.picked['leaseId'], 'settled')).toBe(0);
      }

      it('V1 handback without a successor: refused, no settlement, V2 still current', async () => {
        const state = await superseded('stale handback, no successor');
        const [answer] = await settle([
          asAgent(s, handbackBody(state.work.picked), String(state.work.picked['credential'])),
        ]);
        await assertV2Current(state);
        assertTypedRefusal(answer);
      });

      it('V1 handback with a successor: refused, no successor, V2 still current', async () => {
        const state = await superseded('stale handback, with successor');
        const handedBack = asAgent(
          s,
          handbackBody(state.work.picked, {
            purpose: 'draft_the_reply',
            maximumMinor: 1_000,
            currency: 'AUD',
            payload: { instruction: 'carry on from the stale draft' },
            step: { kind: 'compose', payload: {} },
          }),
          String(state.work.picked['credential']),
        );
        const [answer] = await settle([handedBack]);
        await assertV2Current(state);
        assertTypedRefusal(answer);
      });
    });
  },
);
