// SPDX-License-Identifier: AGPL-3.0-only
//
// The lost-call sweep for a carried call, by what its carriers row proves.
// The request goes to the agent only after `request_at` commits, so a call
// whose `request_at` is null sent nothing: past 60 seconds from its start it
// is released. One whose request may have gone is held at nothing once
// `answer_by` plus 60 seconds has passed, never earlier, so the sweep and an
// answer settling before `answer_by` never meet. Main's 10-minute rule still
// holds a call with no carriers row, and no longer reaches a carried one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  carriageBusiness,
  carriedCall,
  conversationOf,
  dispatchedCall,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Ages {
  /** Seconds since the call started. */
  readonly started: number;
  /** Seconds since `answer_by`; null leaves the request unsent. */
  readonly answerByPast?: number | null;
}

// eslint-disable-next-line max-lines-per-function -- one business, one call per schedule
describe.skipIf(serverUrl === undefined)('the sweep ends a lost carried call', () => {
  let db: FreshDatabase;
  let alpha: CarriageBusiness;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'carried_sweep' });
    alpha = await carriageBusiness(db.app, 'alpha');
  }, 120_000);

  afterAll(async () => await db?.drop());

  /** A carried call aged as `ages` says: started that long ago, and sent if `answerByPast` is set. */
  async function aged(ages: Ages): Promise<string> {
    const { callId } = await db.app.withBusiness(
      alpha.id,
      async (tx) => await carriedCall(tx, alpha.owner, alpha.agent),
    );
    await db.admin.execute(
      `update public.model_calls
          set accepted_at = accepted_at - make_interval(secs => $2),
              started_at = started_at - make_interval(secs => $2)
        where id = $1`,
      [callId, ages.started],
    );
    if (ages.answerByPast !== undefined && ages.answerByPast !== null) {
      await db.admin.execute(
        `update public.model_call_carriers
            set offered_at = clock_timestamp() - make_interval(secs => $2 + 20),
                runner = gen_random_uuid(),
                request_at = clock_timestamp() - make_interval(secs => $2 + 19),
                send_by = clock_timestamp() - make_interval(secs => $2 + 16),
                answer_by = clock_timestamp() - make_interval(secs => $2)
          where call_id = $1`,
        [callId, ages.answerByPast],
      );
    }
    return callId;
  }

  async function uncarried(started: number): Promise<string> {
    const callId = await db.app.withBusiness(
      alpha.id,
      async (tx) => await dispatchedCall(tx, await conversationOf(tx, alpha.owner)),
    );
    await db.admin.execute(
      `update public.model_calls
          set accepted_at = accepted_at - make_interval(secs => $2),
              started_at = started_at - make_interval(secs => $2)
        where id = $1`,
      [callId, started],
    );
    return callId;
  }

  const stateOf = async (callId: string) =>
    (
      await db.admin.execute<{ state: string; drop_state: string | null }>(
        `select state, drop_state from public.model_calls where id = $1`,
        [callId],
      )
    )[0];

  it('releases an unsent call after 60 s and holds a sent one after answer_by + 60 s', async () => {
    const unsentOld = await aged({ started: 61 });
    const unsentYoung = await aged({ started: 30 });
    const sentLate = await aged({ started: 120, answerByPast: 61 });
    const sentInTime = await aged({ started: 700, answerByPast: 30 });
    const plainOld = await uncarried(601);
    const plainYoung = await uncarried(540);

    await db.app.withBusiness(alpha.id, async (tx) => await sweepModelCalls(tx));

    expect(await stateOf(unsentOld)).toEqual({ state: 'released', drop_state: null });
    expect(await stateOf(unsentYoung)).toEqual({ state: 'dispatched', drop_state: null });
    expect(await stateOf(sentLate)).toEqual({
      state: 'liability_unknown',
      drop_state: 'dropped_no_answer',
    });
    // Sent, past main's 10 minutes, but inside its own answer_by + 60 s: left for its answer.
    expect(await stateOf(sentInTime)).toEqual({ state: 'dispatched', drop_state: null });
    expect(await stateOf(plainOld)).toEqual({
      state: 'liability_unknown',
      drop_state: 'dropped_no_answer',
    });
    expect(await stateOf(plainYoung)).toEqual({ state: 'dispatched', drop_state: null });
  });
});
