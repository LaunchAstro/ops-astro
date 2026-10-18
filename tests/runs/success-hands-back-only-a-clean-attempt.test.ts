// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R2, success hands back only a clean attempt. The review handback is
// where success is written (R3), and it refuses an attempt that is not
// clean: one that already has an outcome row of any kind, one with a model
// call still `reserved`, `dispatched` or `liability_unknown`, and one with a
// step-level unknown (the mark `handback.ts` reads). Each refusal is typed and
// writes nothing: no settlement, no successor, the lease and run as they
// were, and the outcome rows unchanged.
//
// Every handback is the worker's own review body through the real HTTP agent
// door, on an accepted plan nobody has launched. The open calls are made
// through the real broker: an unsent hold reserved and never started, a call
// custody holds at a gate after it was sent, and an accepted answer with no
// usage. Two states have no path on a plan's live lease, so they are planted
// on the admin connection: an outcome row beside a live lease (every stop
// writer retires the lease as it writes, R1), and the step's mark. Planted,
// the refusal under test is the handback's own, not the lease's.
//
// Control: a clean attempt, its one turn settled, hands back and writes
// exactly one `success / COMPLETED` row.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import type { Custody } from '../../packages/core-custody/src/index.ts';
import { SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { reviewBody } from '../../apps/worker/review.ts';
import { liveWork, racer, rows, type Work } from '../runtime/schedules-harness.ts';
import { attemptOfLease, type OutcomeRow } from './run-outcomes-read.ts';
import {
  asWorker,
  authorityOf,
  brokerOver,
  callsOf,
  door,
  modelCall,
  named,
  noDatabase,
  outcomesOf,
  s,
  shapeOf,
  useStopWorld,
  world,
  type Answer,
  type Authority,
} from './run-stop-world.ts';
import { reserveUnsent } from './compute-seam-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('r2cleanhandback');

const fresh = async (what: string): Promise<Work> =>
  await liveWork(s, `r2 ${what} ${randomUUID()}`, 2_000);

/** The worker's review handback on the work's lease, through the agent door. */
const reviewHandback = async (work: Work): Promise<Answer> =>
  await asWorker(
    door(),
    work,
    'task/handback',
    reviewBody(
      { leaseId: work.picked['leaseId'], fence: work.picked['fence'] },
      randomUUID(),
      SYNTHETIC_STEP,
      500,
    ),
  );

/** What a refused handback must leave as it found it. */
interface Footprint {
  readonly outcomes: readonly OutcomeRow[];
  readonly authority: Authority;
  readonly attempt: { readonly state: string; readonly outcome: string | null } | undefined;
  readonly settledReports: number;
  readonly versions: number;
}

async function footprintOf(work: Work): Promise<Footprint> {
  const leaseId = work.picked['leaseId'];
  const [attempt] = await rows<{ state: string; outcome: string | null }>(
    s,
    'select state, outcome from public.attempts where business_id = $1 and lease_id = $2',
    [s.business, leaseId],
  );
  const [reports] = await rows<{ n: number }>(
    s,
    `select count(*)::int as n from public.handback_reports
      where business_id = $1 and lease_id = $2 and disposition = 'settled'`,
    [s.business, leaseId],
  );
  const [versions] = await rows<{ n: number }>(
    s,
    'select count(*)::int as n from public.proposal_versions where business_id = $1 and lineage_id = $2',
    [s.business, work.proposal['lineageId']],
  );
  return {
    outcomes: await outcomesOf(work),
    authority: await authorityOf(work),
    attempt,
    settledReports: Number(reports?.n),
    versions: Number(versions?.n),
  };
}

/** The handback is refused with a typed code, and nothing it could write was written. */
async function expectRefusedAndUnwritten(
  answer: Answer,
  work: Work,
  before: Footprint,
): Promise<void> {
  expect(answer.status, 'the handback is refused').not.toBe(200);
  expect(typeof answer.body['code'], 'the refusal is typed').toBe('string');
  expect(await footprintOf(work), 'nothing written, the outcome rows unchanged').toEqual(before);
}

/** Custody waiting at a gate before it dispatches for real, until `open`. */
function gatedCustody(base: Custody = world.custody): {
  readonly custody: Custody;
  readonly open: () => void;
} {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    custody: {
      ...base,
      dispatch: async (...args: Parameters<Custody['dispatch']>) => {
        await gate;
        return await base.dispatch(...args);
      },
    },
    open: () => release?.(),
  };
}

/** Custody whose provider accepted the call and answered, but with no usage in the answer. */
const usageMissing = (base: Custody = world.custody): Custody => ({
  ...base,
  dispatch: async (...args: Parameters<Custody['dispatch']>) => {
    const outcome = await base.dispatch(...args);
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) return outcome;
    const { usage: _usage, ...rest } = JSON.parse(outcome.outbound.body) as Record<string, unknown>;
    return { ...outcome, outbound: { ...outcome.outbound, body: JSON.stringify(rest) } };
  },
});

/** Poll until the work has a call custody is holding, sent and unanswered. */
async function dispatchedOn(work: Work): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if ((await callsOf(work)).some((row) => row.state === 'dispatched')) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error('no call was ever dispatched: the schedule was not established');
}

/**
 * An outcome row beside the live lease, planted on the admin connection. On
 * a tree without the table there is nothing to plant, and the case judges
 * the handback against no row.
 */
async function plantOutcome(work: Work): Promise<void> {
  const columns = await rows<{ name: string; required: boolean; type: string }>(
    s,
    `select column_name as name, data_type as type,
            (is_nullable = 'NO' and column_default is null) as required
       from information_schema.columns
      where table_schema = 'public' and table_name = 'run_outcomes'`,
    [],
  );
  if (columns.length === 0) return;
  const { attemptId, runId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  const known: Readonly<Record<string, unknown>> = {
    business_id: s.business,
    attempt_id: attemptId,
    planned_run_id: runId,
    outcome: 'cancelled',
    end_code: 'TASK_CANCELLED',
    stop_cause: null,
    recorded_at: new Date().toISOString(),
    recorded_by: s.agentActorId,
  };
  const value = (name: string, type: string): unknown => {
    if (name in known) return known[name];
    if (name === 'agent_version') return type.includes('int') ? 1 : 'planted';
    throw new Error(`the plant has no value for run_outcomes.${name}`);
  };
  const planted = columns.filter((column) => column.required || column.name in known);
  await s.db.admin.execute(
    `insert into public.run_outcomes (${planted.map((column) => column.name).join(', ')})
     values (${planted.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    planted.map((column) => value(column.name, column.type)),
  );
}

it('an attempt that already has an outcome row of any kind is refused success', async () => {
  const work = await fresh('outcome already recorded');
  await plantOutcome(work);
  const before = await footprintOf(work);

  await expectRefusedAndUnwritten(await reviewHandback(work), work, before);
});

it('an attempt with a call reserved and never started is refused success', async () => {
  const work = await fresh('call reserved');
  const unsent = await reserveUnsent(work);
  const before = await footprintOf(work);

  await expectRefusedAndUnwritten(await reviewHandback(work), work, before);
  expect((await callsOf(work)).find((row) => row.id === unsent)?.state, 'the hold stays').toBe(
    'reserved',
  );
});

it('an attempt with a call dispatched and unanswered is refused success', async () => {
  const work = await fresh('call dispatched');
  world.provider.mode('answer');
  const gate = gatedCustody();
  const callDb = racer(s);
  const pending = modelCall(work, door(callDb, brokerOver(gate.custody)));
  try {
    await dispatchedOn(work);
    const before = await footprintOf(work);

    await expectRefusedAndUnwritten(await reviewHandback(work), work, before);
  } finally {
    gate.open();
    await Promise.allSettled([pending]);
    await callDb.close();
  }
});

it('an attempt with a call of unknown liability is refused success', async () => {
  const work = await fresh('liability unknown');
  world.provider.mode('answer');
  const answer = await modelCall(work, door(s.db.app, brokerOver(usageMissing())));
  expect(answer.body['detail'], 'setup: the call is held unknown').toMatchObject({
    state: 'liability_unknown',
  });
  const before = await footprintOf(work);

  await expectRefusedAndUnwritten(await reviewHandback(work), work, before);
});

it('an attempt with a step-level unknown is refused success', async () => {
  const work = await fresh('step unknown');
  await s.db.admin.execute(
    `update public.attempts set dispatch_marker = true
      where business_id = $1 and lease_id = $2 and state = 'dispatched'`,
    [s.business, work.picked['leaseId']],
  );
  const before = await footprintOf(work);

  await expectRefusedAndUnwritten(await reviewHandback(work), work, before);
});

it('control: a clean attempt, its turn settled, hands back and writes exactly one success row', async () => {
  const work = await fresh('clean');
  world.provider.mode('answer');
  const turn = await modelCall(work);
  expect(turn.body['detail'], 'setup: the turn settled').toMatchObject({ state: 'settled' });

  const answer = await reviewHandback(work);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(shapeOf(await outcomesOf(work)), 'the handback writes the one success').toEqual([
    named('success', 'COMPLETED'),
  ]);
});
