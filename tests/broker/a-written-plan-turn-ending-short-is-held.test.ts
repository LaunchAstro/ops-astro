// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan, end to end (#2091, after #1929): the
// carried deployment's real turn operation and adapter, through the broker,
// the carriage to the model agent and custody's real process, to the plan's
// stand-in. Once the turn's request is written, the plan may have run it, so
// only a complete answer settles it. A refusal the plan names (400, 401, 403,
// 429), a 503 cut short, a usage limit inside the stream and a connection
// lost with no answer each leave the call held as unknown, never released.
// A held turn stays held across a restart's recovery and sweep, and a replay
// of its operation id answers it held again, and neither asks the plan twice.

import { randomUUID } from 'node:crypto';
import { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  passDeployment,
  recoverDeployment,
  registerEffectLookup,
} from '../../apps/api/recovery-entry.ts';
import { callerAudit, modelCallExecutor } from '../../packages/core-commands/src/index.ts';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/index.ts';
import { reconcileProviderCalls } from '../../packages/core-custody/src/index.ts';
import { completed, sse } from '../custody/fixtures/plan-answer-world.ts';
import { words, type Reply } from '../custody/fixtures/plan-route-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, revisionOf, type Work } from '../runtime/schedules-harness.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';
import { carriedTurn, turnBrokerOf } from './carried-turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('planturnheld');

/** How the stand-in's answer ends after its request has all arrived: whole, cut short, or never. */
type Cut = 'whole' | 'interrupted' | 'lost';

interface Ending {
  readonly reply: Reply;
  readonly cut: Cut;
}

const named = (status: number, error: Readonly<Record<string, string>>): Ending => ({
  reply: { status, body: JSON.stringify({ error }) },
  cut: 'whole',
});

/** The #1929 usage limit: words begun, then `response.failed` naming the limit. */
const usageLimit: Ending = {
  reply: {
    status: 200,
    type: 'text/event-stream',
    body: sse([
      { type: 'response.output_text.delta', delta: 'par' },
      {
        type: 'response.failed',
        response: {
          ...completed(['par']),
          status: 'failed',
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
        },
      },
    ]),
  },
  cut: 'whole',
};

const ENDINGS: readonly (readonly [string, Ending])[] = [
  [
    'a 400 with an error the plan names',
    named(400, { type: 'invalid_request_error', code: 'invalid_value', message: 'Bad input.' }),
  ],
  ['a 401', named(401, { code: 'token_expired', message: 'Sign in again.' })],
  ['a 403', named(403, { code: 'forbidden', message: 'Not allowed.' })],
  ['a 429', named(429, { type: 'usage_limit_reached', message: 'Try again later.' })],
  [
    'a 503 interrupted after its headers and part of its body',
    {
      reply: {
        status: 503,
        body: JSON.stringify({ error: { message: 'Overloaded, try again.' } }),
      },
      cut: 'interrupted',
    },
  ],
  ['a usage limit inside the stream', usageLimit],
  ['a connection lost after the request was written', { reply: words('Never sent.'), cut: 'lost' }],
];

/*
 * The plan's stand-in writes each reply whole (`response.end`). A case that
 * cuts it short takes the stand-in's next `end`, which follows its reply hook
 * in the same tick, so no other response can take it. Headers are stored by
 * `writeHead` and go with the first write, so a lost connection writes none.
 */
let nextCut: Cut = 'whole';
const realEnd = ServerResponse.prototype.end;
function cuttingEnd(this: ServerResponse, ...args: unknown[]): ServerResponse {
  const cut = nextCut;
  nextCut = 'whole';
  if (cut === 'whole') return Reflect.apply(realEnd, this, args) as ServerResponse;
  if (cut === 'interrupted') {
    this.write(String(args[0]).slice(0, 12));
    setTimeout(() => this.destroy(), 30);
  } else {
    this.destroy();
  }
  return this;
}

const stateOf = async (callId: string | null): Promise<unknown> =>
  (await rowsOf(callId))[0]?.['state'];

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

// oxlint-disable-next-line max-lines-per-function -- one carried world, seven endings and their after
describe.skipIf(serverUrl === undefined)('a written plan turn that ends short', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
    ServerResponse.prototype.end = cuttingEnd as typeof realEnd;
  }, 180_000);

  afterAll(async () => {
    ServerResponse.prototype.end = realEnd;
    await world?.close();
  });

  /** `run` with the plan answering as `ending` says; how many requests the plan heard during it. */
  async function answering<T>(ending: Ending, run: () => Promise<T>) {
    const before = world.plan.sent.length;
    const usual = world.plan.reply;
    world.plan.reply = () => {
      nextCut = ending.cut;
      return ending.reply;
    };
    try {
      const result = await run();
      return { result, sent: world.plan.sent.length - before };
    } finally {
      world.plan.reply = usual;
      nextCut = 'whole';
    }
  }

  /** The work's first turn on the plan, ending as `ending` says; its answer, sends and row state. */
  async function turn(work: Work, ending: Ending) {
    const { result: answer, sent } = await answering(ending, async () => {
      return await carriedTurn(world, work);
    });
    const [row] = await rowsOf(answer.callId);
    return { answer, sent, state: row?.['state'] };
  }

  /** A restart, as the API starts: recovery, then its first reconciliation pass with the provider phase. */
  async function restart(): Promise<void> {
    const KEY = 'planturnheld';
    const resolve = async (key: string) =>
      await Promise.resolve(key === KEY ? s.business : undefined);
    const recovered = await recoverDeployment(s.db.app, resolve, [KEY]);
    const passed = await passDeployment(
      s.db.app,
      resolve,
      [KEY],
      registerEffectLookup,
      async (database, businessId, unanswered) =>
        await reconcileProviderCalls(
          database,
          businessId,
          { ...turnBrokerOf(world), audit: callerAudit },
          unanswered,
        ),
    );
    expect({ recovered: recovered.ok, passed: passed.ok }).toEqual({
      recovered: true,
      passed: true,
    });
  }

  it.each(ENDINGS)(
    'a written plan turn that ends in %s is held as unknown, never released',
    async (title, ending) => {
      const called = await turn(await fresh(title), ending);
      expect(called).toMatchObject({ sent: 1, state: 'liability_unknown' });
      expect(called.answer).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
    },
    60_000,
  );

  it('a held plan turn stays unknown across a restart, and the plan is not asked again', async () => {
    const work = await fresh('Held across a restart');
    const lost = ENDINGS.find(([title]) => title.startsWith('a connection lost'))?.[1];
    if (lost === undefined) throw new Error('no lost connection ending');
    const called = await turn(work, lost);
    expect(called).toMatchObject({ sent: 1, state: 'liability_unknown' });
    const { sent } = await answering({ reply: words('Done.'), cut: 'whole' }, restart);
    expect({ sent, state: await stateOf(called.answer.callId) }).toEqual({
      sent: 0,
      state: 'liability_unknown',
    });
  }, 90_000);

  it("a replay of a held plan turn's operation id is refused, the plan is not asked again and the call stays held", async () => {
    const work = await fresh('Held then replayed');
    const execute = modelCallExecutor(turnBrokerOf(world));
    const task = { ref: 'task', taskId: work.taskId, revision: await revisionOf(s, work.taskId) };
    const request = {
      command: 'model.call' as const,
      operationId: randomUUID(),
      leaseId: work.picked['leaseId'],
      fence: work.picked['fence'],
      operation: AGENT_TURN_KEY,
      kind: 'turn',
      turnOrdinal: 0,
      tools: [],
      parts: [task],
    };
    const asTheAgent = async () =>
      await execute(
        s.db.app,
        s.business,
        world.presented,
        String(work.picked['credential']),
        request,
        world.token,
      );
    const first = await answering(
      named(429, { type: 'usage_limit_reached', message: 'Later.' }),
      asTheAgent,
    );
    expect(first).toMatchObject({
      sent: 1,
      result: { detail: { state: 'liability_unknown', outcome: 'LIABILITY_UNKNOWN' } },
    });
    const callId = 'detail' in first.result ? first.result.detail['callId'] : undefined;
    expect(typeof callId).toBe('string');
    const again = await answering({ reply: words('Done.'), cut: 'whole' }, asTheAgent);
    // The held call ended its attempt, so its delegation answers nothing more: no new call is made.
    expect(again).toMatchObject({
      sent: 0,
      result: { refused: true, code: 'DELEGATION_NOT_LIVE' },
    });
    expect(await stateOf(String(callId))).toBe('liability_unknown');
    const [calls] = await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.model_calls where business_id = $1 and lease_id = $2`,
      [s.business, work.picked['leaseId']],
    );
    expect(calls?.n).toBe(1);
  }, 90_000);

  it('control: a written plan turn with a complete answer settles', async () => {
    const called = await turn(await fresh('A complete answer'), {
      reply: words('Done.'),
      cut: 'whole',
    });
    expect(called).toMatchObject({ sent: 1, state: 'settled' });
    expect(called.answer).toMatchObject({ ok: true });
  }, 60_000);
});
