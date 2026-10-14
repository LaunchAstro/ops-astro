// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call's send record and its settlement, each on the function's
// connection, against the lost-call sweep on another, ordered by what
// Postgres reports waiting:
//
// - The sweep releases a call still unsent at 60 s and holds its rows
//   uncommitted; the accept comes and the send record waits on those rows.
//   Once the sweep commits, the record is refused: nothing sent, released.
// - The answer comes while the call's row is held for share (as a carriage
//   judgement holds it), and its settlement waits until `answer_by` has
//   passed on the database's clock. The fence reads the instant after the
//   wait: nothing settles, no reply is kept, the call is held.
// - The sweep holds a sent call past `answer_by` plus 60 s and holds its
//   rows uncommitted; the answer comes and its settlement waits on them.
//   Once the sweep commits, the settlement finds the call held: one hold,
//   no reply, no success.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { holdApp, waitersOf, type HeldApp } from './carried-exchange-fixture.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// Ollama's wait cut to one second, so `answer_by` (the send plus W, the wait and ten seconds) comes soon.
const TIMEOUT_MS = 1_000;

type Swept = Awaited<ReturnType<typeof sweepModelCalls>>;

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried call against the sweep', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_sweep_race', TIMEOUT_MS);
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Swept.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** The sweep in a transaction of its own, held uncommitted until `letGo`. */
  const heldSweep = async (): Promise<HeldApp<Swept>> =>
    await holdApp(
      world.w.fixture.db.appUrl,
      world.w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );

  /** The call asked with `body`, started `seconds` earlier. */
  const age = async (body: string, seconds: number): Promise<void> => {
    await world.w.fixture.db.admin.execute(
      `update public.model_calls c
          set accepted_at = c.accepted_at - make_interval(secs => $2),
              started_at = c.started_at - make_interval(secs => $2)
         from public.conversation_messages m
        where m.business_id = c.business_id and m.id = c.conversation_message_id and m.body = $1`,
      [body, seconds],
    );
  };

  /** The sent call's times moved back together, its `answer_by` `seconds` ago (the set-once guard held off). */
  const answerByAgo = async (seconds: number): Promise<void> => {
    await world.w.fixture.db.admin.transaction(async (execute) => {
      await execute(`set local session_replication_role = replica`);
      await execute(
        `update public.model_call_carriers
            set offered_at = offered_at - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                request_at = request_at - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                send_by = send_by - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                answer_by = clock_timestamp() - make_interval(secs => $1)
          where request_at is not null`,
        [seconds],
      );
    });
  };

  /** Until the call's `answer_by` has passed on the database's clock. */
  const pastAnswerBy = async (body: string): Promise<void> => {
    for (let tries = 0; tries < 400; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- reads the database's clock until it passes
      const [row] = await world.w.fixture.db.admin.execute<{ readonly past: boolean }>(
        `select k.answer_by < clock_timestamp() as past
           from public.model_call_carriers k
           join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
           join public.conversation_messages m on m.id = c.conversation_message_id
          where m.body = $1`,
        [body],
      );
      if (row?.past === true) return;
      // oxlint-disable-next-line no-await-in-loop -- waits between reads
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error('answer_by never passed');
  };

  it('the sweep releasing an unsent call, uncommitted, refuses the send record that waits on it', async () => {
    const body = 'Swept before the send?';
    const holding = latch<HeldApp<Swept>>();
    world.agent.beforeAccept = async () => {
      await age(body, 61);
      holding.open(await heldSweep());
    };
    const asking = ask(world, body);
    const sweep = await holding.promise;
    expect(sweep.taken).toMatchObject({ released: 1 });
    // The send record waits on the rows the sweep holds.
    await waitersOf(world.w.fixture.db.admin, sweep.pid);
    await sweep.letGo();
    const events = await (await asking).rest();
    expect(world.ollama.seen).toHaveLength(0);
    expect(world.agent.sent).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: false, actual: null },
    ]);
    expect(outcome(events)).toMatchObject({ reply: { answered: false } });
  }, 60_000);

  it('a settlement that waits on the call row past answer_by settles nothing and keeps nothing', async () => {
    const body = 'Settled after its time?';
    world.agent.mode = 'late-answer';
    const asking = ask(world, body);
    await world.agent.dispatched(1);
    // The call's row held for share, as a carriage judgement holds it.
    const holder = await holdApp(
      world.w.fixture.db.appUrl,
      world.w.fixture.business,
      async (tx) => {
        await tx.query(
          `select 1 from public.model_calls c
           join public.conversation_messages m
             on m.business_id = c.business_id and m.id = c.conversation_message_id
          where m.body = $1 for share of c`,
          [body],
        );
      },
    );
    world.agent.release();
    await waitersOf(world.w.fixture.db.admin, holder.pid);
    await pastAnswerBy(body);
    await holder.letGo();
    const events = await (await asking).rest();
    expect(await callFor(world, body)).toEqual([
      { state: 'liability_unknown', offered: true, requested: true, actual: null },
    ]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(outcome(events)).toMatchObject({ reply: { answered: false } });
  }, 90_000);

  it('the sweep holding a sent call, uncommitted, leaves the waiting settlement nothing to settle', async () => {
    const body = 'Swept before the answer?';
    world.agent.mode = 'late-answer';
    const asking = ask(world, body);
    await world.agent.dispatched(1);
    await age(body, 600);
    await answerByAgo(61);
    const sweep = await heldSweep();
    expect(sweep.taken).toEqual({ held: 1, released: 0 });
    world.agent.release();
    await waitersOf(world.w.fixture.db.admin, sweep.pid);
    await sweep.letGo();
    const events = await (await asking).rest();
    expect(await callFor(world, body)).toEqual([
      { state: 'liability_unknown', offered: true, requested: true, actual: null },
    ]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(outcome(events)).toMatchObject({ reply: { answered: false, code: 'DECISION_STALE' } });
    const held = await world.w.fixture.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.audit_events where command = 'model.call_held'`,
    );
    expect(held[0]?.n ?? 0).toBeLessThanOrEqual(1);
  }, 60_000);
});
