// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one carried world, a schedule per way the send can lose its footing */
//
// A carried paid call's send judgement judges everything at one locked
// instant, on another connection from each change that races it:
//
//   - committed after the offer and before the send judgement: the person
//     dropped from the people the agent carries for, the outside list naming
//     the person for another business only, the conversation moved off the
//     paid model it was asked on, the session the message came from ended:
//     nothing is sent, the call is released and the whole hold is freed;
//   - started once the send is judged: a model change or a sign-out waits on
//     the judgement's locks (Postgres reports it blocked) until the agent
//     reports the write, so the one request was decided before it; nothing
//     is sent after it, and no deadlock is raised;
//   - the clock: a send judgement that passes only after the send window
//     sends nothing and frees the hold; an offer judgement that waits on a
//     lock longer than the accept window still sends once, on time; an agent
//     an hour ahead or behind still has the call answered and settled once;
//     a write custody would make past the agent's deadline is never made;
//   - an agent whose runner is written in capitals is held to the runner
//     the send recorded: never a second runner, nothing sent;
//   - another business: its chat budget (with no room for a reply) and its rows are
//     never read, held, charged or settled by this business's paid call, and
//     a person the outside list names only for it is refused here, nothing
//     written.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCustody } from '../../apps/model-agent/carrier.ts';
import { ACCEPT_WINDOW_MS, SEND_WINDOW_MS } from '../../packages/core-custody/src/index.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { signBearer } from '../support/sign-in.ts';
import type { HeldApp } from './carried-exchange-fixture.ts';
import { carriedWorld, PAID_HOLD, type CarriedWorld } from './carried-world.ts';
import {
  ask,
  callFor,
  heldFor,
  holdAgent,
  judgementWaits,
  repliesTo,
} from './carried-schedules.ts';
import { carriageAgent } from '../support/carriage-agent.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import { ISSUER, tokenFor } from './fixture.ts';
import { withModelAgent, type CarriedAgent } from './model-agent-carried.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:27b-mlx';
const HOUR = 3_600_000;

/** The owner's bearer for one provider session, as GoTrue signs it. */
async function sessionToken(subject: string, sessionId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
    session_id: sessionId,
    amr: [{ method: 'password', timestamp: now + 1 }],
  });
}

/** Call `k`'s conversation set to `model` (null: the default), as the app role. */
const moveModel = async (tx: TenantQuery, k: string, model: string | null): Promise<void> => {
  await tx.query(
    `update public.conversations v set model_id = $3
       from public.model_calls c
      where c.business_id = $1 and c.id = $2
        and v.business_id = c.business_id and v.id = c.conversation_id`,
    [tx.businessId, k, model],
  );
};

/** Custody as the agent sees it, handed each request only once the agent's deadline has passed. */
const late = (custody: AgentCustody): AgentCustody => ({
  dispatch: async (request, gate, onPiece) => {
    await sleep(Math.max(0, gate.deadlineAt - Date.now()) + 300);
    return await custody.dispatch(request, gate, onPiece);
  },
});

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as { readonly reply?: Record<string, unknown> };

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried paid send judged at one locked instant', () => {
  let world: CarriedWorld;
  let real: CarriedAgent | undefined;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carried_paid_instant', undefined, {}, true);
  }, 180_000);

  afterEach(async () => {
    world?.openrouter?.open();
    await real?.stop();
    real = undefined;
    await world?.close();
    vi.unstubAllEnvs();
  });

  const inBusiness = async (change: (tx: TenantQuery) => Promise<void>): Promise<void> => {
    await world.database.withBusiness(world.w.fixture.business, change);
  };

  async function nothingSent(body: string, events: readonly { readonly data: string }[]) {
    expect(world.openrouter?.received).toHaveLength(0);
    expect(world.agent.sent).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(outcome(events).reply).toMatchObject({ answered: false });
  }

  const changes: Record<string, (k: string) => Promise<void>> = {
    'the person dropped from the people the agent carries for': async () => {
      await Promise.resolve((world.carrier.people as string[]).splice(0));
    },
    'the outside list naming the person for another business only': async () => {
      await Promise.resolve(
        world.outsidePeople.splice(0, 1, `${randomUUID()}:${world.w.owner.personId}`),
      );
    },
    'the conversation moved off the paid model': async (k) =>
      await inBusiness(async (tx) => await moveModel(tx, k, QWEN)),
    'the conversation moved to the default model': async (k) =>
      await inBusiness(async (tx) => await moveModel(tx, k, null)),
  };

  it.each(Object.keys(changes))(
    '%s after the offer, before the send: nothing sent, the whole hold freed',
    async (change) => {
      const body = `Due, paid? (${change})`;
      world.agent.beforeAccept = async (k) => await changes[change]?.(k);
      const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
      await nothingSent(body, events);
    },
    60_000,
  );

  it('the session ended after the offer, before the send: nothing sent, the whole hold freed', async () => {
    const sessionId = randomUUID();
    const token = await sessionToken(world.w.owner.presented.subject, sessionId);
    const body = 'Due, paid? (signed out before the send)';
    world.agent.beforeAccept = async () => {
      await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
        await endOwnSession(tx, world.w.owner.personId, sessionId);
      });
    };
    const events = await (await ask(world, body, token, undefined, HAIKU)).rest();
    await nothingSent(body, events);
  }, 60_000);

  /** Polls until a backend waits on a lock another holds, running a statement like `like`. */
  async function blocked(like: string): Promise<boolean> {
    for (let tries = 0; tries < 300; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const waiting = await world.w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and cardinality(pg_blocking_pids(pid)) > 0 and query like $1`,
        [like],
      );
      if (waiting > 0) return true;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    return false;
  }

  it.each(['a model change', 'a sign-out'] as const)(
    '%s started once the send is judged waits on its locks until the write; one request',
    async (change) => {
      const sessionId = randomUUID();
      const token = await sessionToken(world.w.owner.presented.subject, sessionId);
      const body = `Due, paid? (${change} once judged)`;
      world.openrouter?.shut();
      const asking = ask(world, body, token, undefined, HAIKU);
      await world.openrouter?.arrived(1);
      const own = connect(world.w.fixture.db.appUrl, { source: 'runtime' });
      const [call] = await world.w.fixture.db.admin.execute<{ readonly id: string }>(
        `select c.id::text from public.model_calls c
           join public.conversation_messages m on m.id = c.conversation_message_id
          where m.body = $1`,
        [body],
      );
      const changing = own.withBusiness(world.w.fixture.business, async (tx) => {
        if (change === 'a model change') await moveModel(tx, String(call?.id), QWEN);
        else await endOwnSession(tx, world.w.owner.personId, sessionId);
      });
      let changed = false;
      void changing.then(() => (changed = true));
      try {
        const like = change === 'a model change' ? '%update public.conversations%' : '%';
        expect(await blocked(like), `${change} never waited on the send judgement`).toBe(true);
        expect(changed).toBe(false);
        world.openrouter?.open();
        await changing;
      } finally {
        world.openrouter?.open();
        await changing.catch(() => {});
        await own.close();
      }
      await (await asking).rest();
      expect(world.openrouter?.received).toHaveLength(1);
      expect(world.agent.sent).toHaveLength(1);
      expect(await callFor(world, body)).toMatchObject([{ requested: true }]);
    },
    60_000,
  );

  it('a send judgement that passes only after the send window sends nothing; the hold freed', async () => {
    const body = 'Due, paid? (judged late)';
    const holding = latch<HeldApp<void>>();
    world.agent.beforeAccept = async () => {
      holding.open(await holdAgent(world));
    };
    const asking = ask(world, body, undefined, undefined, HAIKU);
    const held = await holding.promise;
    await judgementWaits(world, held);
    await sleep(SEND_WINDOW_MS + 500);
    await held.letGo();
    const events = await (await asking).rest();
    await nothingSent(body, events);
  }, 60_000);

  it('an offer judgement that waits past the accept window still sends once, on time', async () => {
    const body = 'Due, paid? (offer judged late)';
    let waited: Promise<void> = Promise.resolve();
    world.beforeJoin.run = async () => {
      const held = await holdAgent(world);
      waited = (async () => {
        await judgementWaits(world, held);
        await sleep(ACCEPT_WINDOW_MS + 500);
        await held.letGo();
      })();
    };
    const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
    await waited;
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await callFor(world, body)).toMatchObject([{ state: 'settled', requested: true }]);
    expect(await repliesTo(world, body)).toBe(1);
    expect(outcome(events).reply).toMatchObject({ answered: true });
  }, 60_000);

  it.each([
    ['an hour ahead', HOUR],
    ['an hour behind', -HOUR],
  ] as const)(
    'an agent whose clock is %s: one request, settled once at its cost',
    async (_name, offset) => {
      world.agent.clockOffset = offset;
      const body = `Due, paid? (clock ${String(offset)})`;
      const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
      expect(world.openrouter?.received).toHaveLength(1);
      const [call] = await callFor(world, body);
      expect(call).toMatchObject({ state: 'settled', requested: true });
      expect(await heldFor(world, body)).toEqual([
        { reserved: PAID_HOLD, committed: call?.actual },
      ]);
      expect(outcome(events).reply).toMatchObject({ answered: true });
    },
    60_000,
  );

  it('custody handed the request after the agent’s deadline writes nothing; released, the hold freed', async () => {
    real = await withModelAgent(world, late);
    const body = 'Due, paid? (handed to custody too late)';
    const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
    expect(world.openrouter?.received).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
    expect(outcome(events).reply).toMatchObject({ answered: false });
  }, 60_000);

  it('an agent accepting under its runner in capitals: never a second runner, nothing sent', async () => {
    world.agent.mode = 'silent';
    const { fixture } = world.w;
    const capitals = await carriageAgent({
      carriage: hubCarriage(world.hub),
      business: fixture.business,
      agent: fixture.agentActorId,
      token: await tokenFor(fixture.agent.subject),
      key: world.key,
      keys: world.keys,
      ollama: world.ollama.origin,
      openrouter: world.openrouter?.origin ?? '',
      runner: randomUUID().toUpperCase(),
    });
    try {
      const body = 'Due, paid? (a runner in capitals)';
      const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
      expect(capitals.accepted).toHaveLength(1);
      expect(capitals.sent).toHaveLength(0);
      expect(world.openrouter?.received).toHaveLength(0);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested: true, actual: null },
      ]);
      expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
      expect(outcome(events).reply).toMatchObject({ answered: false });
    } finally {
      await capitals.stop();
    }
  }, 60_000);

  // oxlint-disable-next-line max-lines-per-function -- another business, its rows before and after
  it('another business’s budget and rows are never read, held, charged or settled', async () => {
    const { db } = world.w.fixture;
    const bravo = await insertBusiness(db.app, `bravo_${randomUUID().slice(0, 8)}`);
    await db.admin.execute(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'planning', 1, 'AUD')`,
      [bravo, randomUUID()],
    );
    const rowsOf = async () =>
      await db.admin.execute(
        `select (select json_agg(c order by c.id) from public.budget_caps c where c.business_id = $1) as caps,
                (select count(*)::int from public.planning_envelopes e where e.business_id = $1) as envelopes,
                (select count(*)::int from public.model_calls m where m.business_id = $1) as calls`,
        [bravo],
      );
    const before = await rowsOf();
    const body = 'Due, paid? (bravo has no room)';
    const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
    expect(outcome(events).reply).toMatchObject({ answered: true });
    const [call] = await callFor(world, body);
    expect(call).toMatchObject({ state: 'settled' });
    expect(await rowsOf()).toEqual(before);
    // The owner listed for bravo only: refused here, nothing written, nothing sent.
    world.outsidePeople.splice(0, 1, `${bravo}:${world.w.owner.personId}`);
    const refusedBody = 'Due, paid? (listed for bravo only)';
    const refused = await (await ask(world, refusedBody, undefined, undefined, HAIKU)).rest();
    expect(outcome(refused).reply).toMatchObject({ answered: false });
    expect(await callFor(world, refusedBody)).toEqual([]);
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await rowsOf()).toEqual(before);
  }, 60_000);
});
