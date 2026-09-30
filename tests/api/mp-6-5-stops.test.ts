// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-5's stop states and C54's answers at the budget stop, through the real
// boundary and a fresh Postgres: a run the broker really stopped at its
// approved ceiling (`stopped-run.ts`), read back through `task.read`'s ledger,
// answered through the page's own client (`run.top_up`,
// `run.end_at_budget_stop`, AW-05). The stored asks, answers and approvals,
// read with the admin role, are the oracle.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRefusal, isUnavailable } from '../../apps/web/src/operations/client.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { answerAtTheStop } from '../acceptance/stopped-run.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import {
  agentOnWork,
  asAgent,
  asPerson,
  billingHolder,
  contextOf,
  externalClient,
  pageClient,
  setBand,
  signed,
  type Signed,
} from './c54-fixture.ts';

interface Stopped {
  readonly recordId: string;
  readonly runId: string;
}

interface AskRow {
  readonly id: string;
  readonly reservation_id: string;
  readonly lease_id: string;
  readonly decision_id: string;
  readonly ceiling_minor: string;
  readonly spent_minor: string;
  readonly currency: string;
  readonly raised_at: string;
}

type Stop = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, each stop state on it
describe.skipIf(serverUrl === undefined)('MP-6-5 and C54 stops on Postgres', () => {
  let world: World;
  let ada: Signed;
  let one: Stopped;
  let two: Stopped;

  async function stop(): Promise<Stopped> {
    const context = {
      ...contextOf(world, ada),
      asAgent: async (
        name: CommandName,
        body: Readonly<Record<string, unknown>>,
        credential?: string,
      ) => await asAgent(world, name, body, String(credential)),
    };
    const made = await answerAtTheStop(context, 'run.end_at_budget_stop', PROPOSAL);
    if (!('body' in made)) throw new Error(made.exception);
    return { recordId: String(made.body['recordId']), runId: String(made.body['runId']) };
  }

  beforeAll(async () => {
    world = await createWorld('mp65stops');
    ada = signed(world.ada);
    one = await stop();
    two = await stop();
  }, 240_000);

  afterAll(async () => await world?.close());

  async function stopsOf(who: Signed, taskId: string): Promise<readonly Stop[]> {
    const read = await asPerson(world, who, 'task.read', { recordId: taskId });
    expect(read.code, 'task.read').toBe('ok');
    const task = read.body['task'] as { readonly ledger: { readonly stops: readonly Stop[] } };
    return task.ledger.stops;
  }

  async function asksOf(runId: string): Promise<readonly AskRow[]> {
    return (await world.db.admin.execute(
      `select id, reservation_id, lease_id, decision_id, ceiling_minor::text as ceiling_minor,
              spent_minor::text as spent_minor, currency, raised_at::text as raised_at
         from public.budget_asks where run_id = $1 order by ask_number`,
      [runId],
    )) as readonly AskRow[];
  }

  async function answer(
    who: Signed,
    name: 'run.top_up' | 'run.end_at_budget_stop',
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly code: string; readonly state: unknown }> {
    const result = await pageClient(world, who).mutate(name, body);
    if (isUnavailable(result)) throw new Error(`${name} unreachable`);
    if (isRefusal(result)) return { code: result.code, state: undefined };
    return { code: 'ok', state: result.value.detail?.['state'] };
  }

  it('MP-6-5 stop states: the read carries the stop as the broker raised it, unanswered', async () => {
    const [row] = await asksOf(one.runId);
    expect(await stopsOf(ada, one.recordId)).toStrictEqual([
      {
        askId: row?.id,
        runId: one.runId,
        number: 1,
        kind: 'stop',
        ceilingMinor: Number(row?.ceiling_minor),
        spentMinor: Number(row?.spent_minor),
        currency: row?.currency,
        raisedAt: new Date(String(row?.raised_at)).toISOString(),
        answer: null,
        awaitingSecond: null,
      },
    ]);
  });

  it('MP-6-5 isolation: a task reads only its own stops; another business, another client and another person’s agent read none of them', async () => {
    const [ownOne] = await asksOf(one.runId);
    const [ownTwo] = await asksOf(two.runId);
    const readTwo = await stopsOf(ada, two.recordId);
    expect(readTwo.map((s) => s['askId'])).toStrictEqual([ownTwo?.id]);
    expect(JSON.stringify(readTwo)).not.toContain(String(ownOne?.id));
    // Another client in the same business, on the one task shared with them.
    const client = await externalClient(world, ada, two.recordId);
    const theirs = await asPerson(world, client, 'task.read', { recordId: one.recordId });
    expect(theirs.status).toBeGreaterThanOrEqual(403);
    expect(JSON.stringify(theirs.body)).not.toContain(String(ownOne?.id));
    const shared = await asPerson(world, client, 'task.read', { recordId: two.recordId });
    expect(JSON.stringify(shared.body)).not.toContain(String(ownOne?.id));
    // Another person under a live delegation: the agent working ada's other task.
    const agent = await agentOnWork(world, ada);
    const delegated = await asAgent(
      world,
      'task.read',
      { recordId: one.recordId },
      agent.credential,
    );
    expect(delegated.status).toBe(403);
    expect(JSON.stringify(delegated.body)).not.toContain(String(ownOne?.id));
    // Another business: bravo's member names alpha's task.
    const bravo = await billingHolder(world, world.bravo, 'bravo', 'mp65-bravo');
    const foreign = await asPerson(world, bravo, 'task.read', { recordId: one.recordId });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(String(ownOne?.id));
  });

  it('C54 top-up approver: above the band the first top-up reads as awaiting a second person, and a second holder completes it', async () => {
    await setBand(world, world.alpha, '1');
    try {
      const body = {
        recordId: one.recordId,
        runId: one.runId,
        amountMinor: 150,
        currency: 'AUD',
      };
      expect(await answer(ada, 'run.top_up', body)).toStrictEqual({
        code: 'ok',
        state: 'awaiting_second',
      });
      const waiting = await stopsOf(ada, one.recordId);
      expect(waiting.at(-1)).toMatchObject({
        answer: null,
        awaitingSecond: { amountMinor: 150 },
      });
      const second = await billingHolder(world, world.alpha, 'alpha', 'mp65-second');
      expect(await answer(second, 'run.top_up', body)).toStrictEqual({
        code: 'ok',
        state: 'applied',
      });
      expect((await stopsOf(ada, one.recordId)).at(-1)).toMatchObject({
        number: 1,
        answer: 'top_up',
        awaitingSecond: null,
      });
    } finally {
      await setBand(world, world.alpha, 'null');
    }
  });

  it('C54 consolidated stop answered: the end reads as the answer and the run is cancelled', async () => {
    expect(
      await answer(ada, 'run.end_at_budget_stop', { recordId: two.recordId, runId: two.runId }),
    ).toStrictEqual({ code: 'ok', state: 'cancelled' });
    expect(await stopsOf(ada, two.recordId)).toMatchObject([{ number: 1, answer: 'end' }]);
  });

  it('MP-6-5 stop states: the third ask reads as the one consolidated decision', async () => {
    // Asks two and three as the broker writes them on this run's later stops,
    // on the same reservation, lease and plan decision as its first.
    const [first] = await asksOf(one.runId);
    for (const number of [2, 3]) {
      // eslint-disable-next-line no-await-in-loop -- the numbers are ordered
      await world.db.admin.execute(
        `insert into public.budget_asks
           (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
            ceiling_minor, spent_minor, currency)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::smallint,
                 case when $6::smallint = 3 then 'consolidated' else 'stop' end, $7::bigint, $7::bigint, 'AUD')`,
        [
          world.alpha,
          one.runId,
          first?.reservation_id,
          first?.lease_id,
          first?.decision_id,
          number,
          first?.ceiling_minor,
        ],
      );
    }
    const stops = await stopsOf(ada, one.recordId);
    expect(stops.map((s) => [s['number'], s['kind']])).toStrictEqual([
      [1, 'stop'],
      [2, 'stop'],
      [3, 'consolidated'],
    ]);
  });
});
