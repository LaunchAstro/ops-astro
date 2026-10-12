// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation call and a priced planning reply write their started row,
// go through custody, and settle the row from the answer (`sendAndSettle`).
// The sweep holds a started row once its time is past, on the same row. Each
// racer here is a connection of its own: the row is held on a third, both
// are seen parked on it in the order the case names, then it is let go. A
// lost reply is a relay cut at a named point of one transaction's commit.

import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { replayAdapter } from '../../packages/core-connectors/src/index.ts';
import {
  callModelForPlanning,
  callModelInConversation,
  sweepModelCalls,
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { CONVERSATION_CALL_LIFE_MS } from '../../packages/core-custody/src/broker-conversation.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import {
  awaitParked,
  cutProxy,
  holdRows,
  racer,
  settle,
  type CutPoint,
} from '../runtime/schedules-harness.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('answersweep');

beforeAll(async () => {
  if (!noDatabase) await setCap(s, 1_000_000);
});

type Calling = (
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ConversationCallRequest,
  broker: Broker,
) => Promise<ModelCallResult>;

/** The conversation seam priced at nothing; the planning reply at the replay price. */
const SEAMS: readonly (readonly [string, Calling, () => Broker])[] = [
  [
    'a conversation call',
    callModelInConversation,
    () => ({
      ...local(s),
      providers: new Map([['replay', { build: replayAdapter, price: () => 0 }]]),
    }),
  ],
  ['a priced planning reply', callModelForPlanning, () => local(s)],
];

/** `base` with custody waiting for `open` before it dispatches, and every `notAfter` it was handed. */
function gatedCustody(base: Broker) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const notAfters: (number | undefined)[] = [];
  const dispatch: Broker['custody']['dispatch'] = async (credentialRef, request) => {
    notAfters.push(request.notAfter);
    reached();
    await gate;
    return await base.custody.dispatch(credentialRef, request);
  };
  return {
    broker: { ...base, custody: { ...base.custody, dispatch } },
    open,
    atGate,
    notAfters,
  };
}

const rowOf = async (conversationId: string) =>
  await s.db.admin.execute<{
    id: string;
    state: string;
    actual_minor: string | null;
    started_ms: number;
  }>(
    `select id, state, actual_minor::text,
            (extract(epoch from started_at) * 1000)::float8 as started_ms
       from public.model_calls where conversation_id = $1 order by started_at`,
    [conversationId],
  );

/** Calls matching `where` moved back past their life, as the sweep reads it. */
async function pastItsLife(where: string, parameters: readonly unknown[]): Promise<void> {
  const back = `$${String(parameters.length + 1)}::float8 * interval '1 millisecond'`;
  await s.db.admin.execute(
    `update public.model_calls
        set accepted_at = accepted_at - ${back}, started_at = started_at - ${back}
      where ${where}`,
    [...parameters, CONVERSATION_CALL_LIFE_MS + 60_000],
  );
}

const sweepOn = async (database: Database) =>
  await database.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));

it.each(
  SEAMS.flatMap(([name, calling, brokerOf]) =>
    (['the answer', 'the sweep'] as const).map(
      (first) => [name, first, calling, brokerOf] as const,
    ),
  ),
)(
  '%s answered while the sweep holds it, %s first in the queue: the call answers as its row ends',
  async (_name, first, calling, brokerOf) => {
    world.provider.mode('answer');
    const request = await ask(s);
    const gated = gatedCustody(brokerOf());
    const sent = world.provider.seen.length;
    const answer = calling(s.db.app, s.business, ownerOf(s), request, gated.broker);
    await gated.atGate;
    const [row] = await rowOf(request.conversation.id);
    if (row === undefined) throw new Error('the call wrote no started row');
    // The row's time is past, as the sweep reads it.
    await pastItsLife('id = $1', [row.id]);
    const holder = await holdRows(s, 'model_calls', [row.id]);
    const sweeper = racer(s);
    try {
      let sweep: Promise<unknown>;
      if (first === 'the answer') {
        gated.open();
        await awaitParked(s, 'model_calls', 1);
        sweep = sweepOn(sweeper);
      } else {
        sweep = sweepOn(sweeper);
        await awaitParked(s, 'model_calls', 1);
        gated.open();
      }
      await awaitParked(s, 'model_calls', 2);
      await holder.release();
      const [answered, swept] = await settle([answer, sweep]);
      expect(swept?.status).toBe('fulfilled');
      if (answered?.status !== 'fulfilled') throw new Error('the call threw');
      const [after] = await rowOf(request.conversation.id);
      expect({
        result: answered.value,
        state: after?.state,
        sent: world.provider.seen.length - sent,
      }).toMatchObject({
        result: { ok: true, actualMinor: Number(after?.actual_minor) },
        state: 'settled',
        sent: 1,
      });
    } finally {
      await sweeper.close();
    }
  },
);

it.each(SEAMS)(
  '%s that waited on a lock before its row is told to end before the sweep would hold it',
  async (name, calling, brokerOf) => {
    world.provider.mode('answer');
    const request = await ask(s);
    const gated = gatedCustody(brokerOf());
    gated.open();
    // The planning reply waits on the cap row; the conversation call on its ceiling's lock.
    const blocker = racer(s);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.withBusiness(s.business, async (tx) => {
      await (name === 'a priced planning reply'
        ? tx.query(
            `select id from public.budget_caps
              where business_id = $1 and key = 'planning' for update`,
            [s.business],
          )
        : tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `limit:${s.business}:model_call:${request.operation}`,
          ]));
      locked();
      await released;
    });
    await isLocked;
    try {
      const answer = calling(s.db.app, s.business, ownerOf(s), request, gated.broker);
      await awaitParked(s, name === 'a priced planning reply' ? 'budget_caps' : 'advisory', 1);
      await delay(1_500);
      release();
      await blocking;
      expect(await answer).toMatchObject({ ok: true });
    } finally {
      release();
      await blocker.close();
    }
    const [row] = await rowOf(request.conversation.id);
    const [notAfter] = gated.notAfters;
    if (row === undefined || notAfter === undefined) throw new Error('nothing was dispatched');
    // A second of leeway for the two hosts' clocks; the wait itself was longer.
    expect(notAfter).toBeLessThanOrEqual(row.started_ms + CONVERSATION_CALL_LIFE_MS - 4_000);
  },
);

/** `base`, its transactions after the first `skip` running over `through`. */
const after = (base: Database, through: Database, skip: number): Database => {
  let seen = 0;
  return {
    ...base,
    withBusiness: async (businessId, run) => {
      seen += 1;
      return await (seen > skip ? through : base).withBusiness(businessId, run);
    },
  };
};

/** `work` over the app database, its transaction after the first `skip` cut at `point`. */
async function cutOnce(
  point: CutPoint,
  skip: number,
  work: (database: Database) => Promise<void>,
): Promise<void> {
  const proxy = await cutProxy(s.db.appUrl, point);
  const cut = racer(s, proxy.url);
  try {
    const [interrupted] = await settle([work(after(s.db.app, cut, skip))]);
    expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
    expect(interrupted?.status).toBe('rejected');
  } finally {
    // A client whose socket the relay killed may never finish ending: give it a second.
    await Promise.race([cut.close().catch(() => null), delay(1_000)]);
    await proxy.close();
  }
}

it.each(
  SEAMS.flatMap(([name, calling, brokerOf]) =>
    (['before-commit', 'after-commit'] as const).flatMap((point) =>
      (['started row', 'settlement'] as const).map(
        (step) => [name, step, point, calling, brokerOf] as const,
      ),
    ),
  ),
)(
  '%s whose %s is cut %s sends at most once, and the retry is the one answer',
  async (_name, step, point: CutPoint, calling, brokerOf) => {
    world.provider.mode('answer');
    const request = await ask(s);
    const sent = world.provider.seen.length;
    await cutOnce(point, step === 'started row' ? 0 : 1, async (database) => {
      await calling(database, s.business, ownerOf(s), request, brokerOf());
    });
    const cutRows = await rowOf(request.conversation.id);
    const cutSent = world.provider.seen.length - sent;
    const retried = await calling(s.db.app, s.business, ownerOf(s), request, brokerOf());
    expect(retried).toMatchObject({ ok: true });
    const rows = await rowOf(request.conversation.id);
    const settled = rows.filter((row) => row.state === 'settled');
    // The cut call reached the provider only if its row committed and the cut came after the send.
    expect({ cutSent, cutRows: cutRows.map((row) => row.state) }).toEqual(
      step === 'started row'
        ? { cutSent: 0, cutRows: point === 'after-commit' ? ['dispatched'] : [] }
        : { cutSent: 1, cutRows: [point === 'after-commit' ? 'settled' : 'dispatched'] },
    );
    // The retry is sent once and settles once; nothing the cut left is settled twice.
    expect(world.provider.seen.length - sent).toBe(cutSent + 1);
    expect(settled.length).toBe(step === 'settlement' && point === 'after-commit' ? 2 : 1);
    // The sweep holds an orphan never answered, and never settles or releases it.
    await pastItsLife('conversation_id = $1 and state = $2', [
      request.conversation.id,
      'dispatched',
    ]);
    await sweepOn(s.db.app);
    const swept = await rowOf(request.conversation.id);
    expect(swept.filter((row) => row.state === 'settled').length).toBe(settled.length);
    expect(swept.every((row) => row.state === 'settled' || row.state === 'liability_unknown')).toBe(
      true,
    );
  },
);
