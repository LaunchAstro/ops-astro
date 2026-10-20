// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05: a call past the ceiling after the run's last ask ends the run, and
// the stopped hold ends with it as a person's end does: abandoned at its spend
// to date, the rest back to the envelope, so cancelled work holds nothing of
// the cap until a recovery pass.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callModel, type Broker } from '../../packages/core-custody/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { liveWork, openSchedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

type World = Awaited<ReturnType<typeof openSchedules>>;
type Work = Awaited<ReturnType<typeof liveWork>>;

/** The run's three asks, the last the consolidated decision, raised before this call. */
async function askedThreeTimes(s: World, work: Work, runId: string): Promise<void> {
  for (let n = 1; n <= 3; n++) {
    // One ask at a time, each numbered after the last.
    // eslint-disable-next-line no-await-in-loop
    await s.db.admin.execute(
      `insert into public.budget_asks
      (business_id,id,run_id,reservation_id,lease_id,decision_id,ask_number,kind,ceiling_minor,spent_minor,currency)
      values ($1,$2,$3,$4,$5,$6,$7,$8,400,0,'AUD')`,
      [
        s.business,
        randomUUID(),
        runId,
        work.decision['reservationId'],
        work.picked['leaseId'],
        work.decision['decisionId'],
        n,
        n === 3 ? 'consolidated' : 'stop',
      ],
    );
  }
}

/** The replay operation on a route whose custody must never send. */
const neverSends = (): Broker => ({
  operations: catalogue([REPLAY_COMPOSE]),
  providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
  routes: [
    {
      key: 'replay',
      reach: 'cloud',
      provider: 'replay',
      credentialRef: 'invented',
      credentialKind: 'api_key',
      installation: 'here',
      ceiling: 1000,
    },
  ],
  installation: 'here',
  audit: () => Promise.resolve(),
  custody: {
    describe: () => Promise.resolve(null),
    dispatch: () => Promise.reject(new Error('must not send')),
  } as unknown as Broker['custody'],
});

/** The call on the run's first step, past its ceiling. */
async function callPastTheCeiling(s: World, work: Work, runId: string) {
  const [step] = await s.db.admin.execute<{ id: string }>(
    'select id from public.planned_steps where run_id=$1 order by ordinal limit 1',
    [runId],
  );
  return await callModel(
    s.db.app,
    s.business,
    {
      actorId: s.agentActorId,
      delegationId: String(work.picked['delegationId']),
      attendedByPersonId: null,
    },
    {
      leaseId: String(work.picked['leaseId']),
      fence: Number(work.picked['fence']),
      stepId: step!.id,
      operation: REPLAY_COMPOSE.key,
      fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
    },
    neverSends(),
  );
}

describe.skipIf(serverUrl === undefined)('the end at the last budget ask', () => {
  it('ending at the final budget ask releases the unused hold', async () => {
    const s = await openSchedules('lastaskrelease', 400);
    try {
      const work = await liveWork(s, 'unused final hold', 400);
      const [row] = await s.db.admin.execute<{ run_id: string; version_id: string }>(
        'select run_id, version_id from public.reservations where id = $1',
        [work.decision['reservationId']],
      );
      if (row === undefined) throw new Error('missing reservation');
      await askedThreeTimes(s, work, row.run_id);
      const result = await callPastTheCeiling(s, work, row.run_id);
      expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
      const [after] = await s.db.admin.execute(
        `select run.state as run, r.state as reservation,
        env.held_minor::int as held from public.reservations r
        join public.planned_runs run on run.id=r.run_id
        join public.task_envelopes env on env.id=r.envelope_id where r.id=$1`,
        [work.decision['reservationId']],
      );
      expect(after).toEqual({ run: 'cancelled', reservation: 'abandoned', held: 0 });
    } finally {
      await s.db.drop();
    }
  }, 60_000);
});
