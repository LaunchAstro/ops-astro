// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried paid call that loses its way after the request was written ends
// once, at what it may have cost, and is never sent twice:
//
//   - the function's instance dies after the write, before the answer: the
//     call stays sent; the sweep, on another connection once `answer_by` has
//     passed, holds it at the most; the same message sent again on another
//     instance is told the answer ended, and nothing is sent a second time;
//   - the sweep holds the call while the answer is still on its way, then the
//     answer arrives priced: no reply is kept and the most stays held, and
//     what OpenRouter reported it cost is recorded for the owner who must
//     resolve the hold (the settlement lost to the sweep, as the settle fence
//     reports one);
//   - the reply cannot be kept (the conversation purged after the write): the
//     settlement holds the most, keeps nothing, and records the observed cost.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, PAID_HOLD, type CarriedTwin, type CarriedWorld } from './carried-world.ts';
import { callFor, heldFor, repliesTo } from './carried-schedules.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as { readonly reply?: Record<string, unknown> };

/** OpenRouter's reported cost for the stand-in's answer, in AUD cents, rounded up. */
const STAND_IN_COST_MINOR = 1;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried paid call lost mid-way', () => {
  let world: CarriedWorld;
  let twin: CarriedTwin | undefined;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carried_paid_lost', undefined, {}, true);
  }, 180_000);

  afterEach(async () => {
    world?.agent.release();
    await twin?.close().catch(() => {});
    twin = undefined;
    await world?.close();
    vi.unstubAllEnvs();
  });

  const start = (api: CarriedWorld['api'], operationId: string, body: string) =>
    sendStreaming(api, world.w.owner, 'conversation.start', { operationId, body, model: HAIKU });

  async function callOf(body: string): Promise<string> {
    const [row] = await world.w.fixture.db.admin.execute<{ readonly id: string }>(
      `select c.id::text from public.model_calls c
         join public.conversation_messages m on m.id = c.conversation_message_id
        where m.body = $1`,
      [body],
    );
    if (row === undefined) throw new Error('no call');
    return row.id;
  }

  /**
   * Call `k`'s times moved back together until `answer_by` is a minute and
   * more ago, as if that long had passed: the clock moved, not the row's
   * story. The carriers row's set-once guard is a trigger, held off for this
   * one statement only.
   */
  const pastAnswerBy = async (k: string): Promise<void> => {
    await world.w.fixture.db.admin.transaction(async (execute) => {
      await execute(`set local session_replication_role = replica`);
      await execute(
        `update public.model_call_carriers
            set offered_at = offered_at - (answer_by - clock_timestamp() + interval '61 seconds'),
                request_at = request_at - (answer_by - clock_timestamp() + interval '61 seconds'),
                send_by = send_by - (answer_by - clock_timestamp() + interval '61 seconds'),
                answer_by = clock_timestamp() - interval '61 seconds'
          where call_id = $1 and request_at is not null`,
        [k],
      );
    });
  };

  /** The sweep, as the worker runs it, on a connection of its own. */
  const sweep = async () =>
    await world.w.fixture.db.app.withBusiness(
      world.w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );

  /** What the owner can see of the cost OpenRouter reported for call `k`. */
  async function observedOf(k: string): Promise<{ row: number | null; lost: number[] }> {
    const [row] = await world.w.fixture.db.admin.execute<{ readonly observed: number | null }>(
      'select observed_minor::int as observed from public.model_calls where id = $1',
      [k],
    );
    const lost = await world.w.fixture.db.admin.execute<{ readonly observed: number | null }>(
      `select (attempted->>'observedMinor')::int as observed from public.audit_events
        where business_id = $1 and command = 'model.call_settle_lost'
          and attempted->>'callId' = $2`,
      [world.w.fixture.business, k],
    );
    return { row: row?.observed ?? null, lost: lost.map((one) => Number(one.observed)) };
  }

  it('the instance dies after the write: the sweep holds the most, and a resend sends nothing', async () => {
    twin = await world.twin();
    world.agent.mode = 'late-answer';
    const body = 'Due, paid? (the instance died after the write)';
    const operationId = randomUUID();
    const dying = start(twin.api, operationId, body);
    await world.agent.dispatched(1);
    await world.openrouter?.arrived(1);
    const k = await callOf(body);
    // The instance is gone: nothing it would still write can reach the database.
    await twin.database.close();
    world.agent.release();
    await (await dying).rest().catch(() => []);
    expect(await callFor(world, body)).toMatchObject([{ state: 'dispatched', requested: true }]);
    await pastAnswerBy(k);
    expect(await sweep()).toMatchObject({ held: 1, released: 0 });
    const again = outcome(await (await start(world.api, operationId, body)).rest());
    expect(again.reply).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await callFor(world, body)).toMatchObject([{ state: 'liability_unknown' }]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: PAID_HOLD }]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(await sweep()).toMatchObject({ held: 0, released: 0 });
  }, 60_000);

  it('held by the sweep before its priced answer arrives: nothing kept, the most held, the cost recorded', async () => {
    world.agent.mode = 'late-answer';
    const body = 'Due, paid? (swept before the answer)';
    const asking = start(world.api, randomUUID(), body);
    await world.agent.dispatched(1);
    await world.openrouter?.arrived(1);
    // The agent has the whole answer and waits to send it.
    await sleep(500);
    const k = await callOf(body);
    await pastAnswerBy(k);
    expect(await sweep()).toMatchObject({ held: 1 });
    world.agent.release();
    const events = await (await asking).rest();
    expect(outcome(events).reply).toMatchObject({ answered: false });
    expect(await callFor(world, body)).toMatchObject([
      { state: 'liability_unknown', actual: null },
    ]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: PAID_HOLD }]);
    expect(await repliesTo(world, body)).toBe(0);
    const observed = await observedOf(k);
    expect(
      observed.row === STAND_IN_COST_MINOR || observed.lost.includes(STAND_IN_COST_MINOR),
      `OpenRouter's reported cost for the swept call is recorded nowhere: ${JSON.stringify(observed)}`,
    ).toBe(true);
  }, 60_000);

  it('a reply that cannot be kept: the most held, nothing kept, the cost recorded', async () => {
    world.agent.mode = 'late-answer';
    const body = 'Due, paid? (purged after the write)';
    const asking = start(world.api, randomUUID(), body);
    await world.agent.dispatched(1);
    await world.openrouter?.arrived(1);
    const k = await callOf(body);
    await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
      await tx.query(
        `update public.conversations v
            set body_purged_at = clock_timestamp(), purge_operation_id = $3
           from public.model_calls c
          where c.business_id = $1 and c.id = $2
            and v.business_id = c.business_id and v.id = c.conversation_id`,
        [tx.businessId, k, randomUUID()],
      );
    });
    world.agent.release();
    const events = await (await asking).rest();
    expect(outcome(events).reply?.['answered']).not.toBe(true);
    const [call] = await world.w.fixture.db.admin.execute<{
      readonly state: string;
      readonly reserved: number;
    }>('select state, reserved_minor::int as reserved from public.model_calls where id = $1', [k]);
    expect(call).toEqual({ state: 'liability_unknown', reserved: PAID_HOLD });
    expect((await observedOf(k)).row).toBe(STAND_IN_COST_MINOR);
  }, 60_000);
});
