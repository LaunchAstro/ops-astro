// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world and the call start's schedules against each closer */
//
// A carried call's start (`carriedIn`, then the call and its carriers row)
// races what closes the agent's membership: another model picked
// (`conversation.set_model`), a purge, the agent's deactivation. The call is
// the shipped exchange over a broker that carries (`Broker.carrier`) where it
// waits, or the product's `carriedIn` and `writeCarriers` in a transaction
// held open on a connection of its own where it must go first. Schedules are
// set by what `pg_stat_activity` shows, never by sleeps.
//
// Held: a closing writer that commits first leaves the call refused, nothing
// written and nothing sent; one that comes second waits for the call, so no
// carriers row is written for a membership already closed at the call's
// commit; a call that dies after its read leaves nothing. Asked too: the
// close time a waiting closer records is read after its wait; a model pick
// and a call at once both finish; two picks at once leave at most one open
// membership; a carrier naming another business's agent carries nothing; a
// conversation named in capitals is the same conversation.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { carriedIn, writeCarriers } from '../../packages/core-custody/src/broker-carriage.ts';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { followModel } from '../../packages/core-commands/src/commands/conversation-agents.ts';
import type { CommandContext } from '../../packages/core-commands/src/commands/context.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { carriageBusiness, dispatchedCall } from './carriage-fixture.ts';
import {
  blockedIn,
  carriedApi,
  carriedOllama,
  holdApp,
  waitersOf,
} from './carried-exchange-fixture.ts';
import { personPath } from './controls-fixture.ts';
import { authorised, createApiFixture, post, tokenFor } from './fixture.ts';
import { says, standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:27b-mlx';

const as = async (api: Hono, member: Member, name: string, body: Record<string, unknown>) =>
  await post(
    api,
    personPath(name),
    { operationId: randomUUID(), ...body },
    authorised(await tokenFor(member.presented.subject)),
  );

const within = async <T>(ms: number, work: Promise<T>): Promise<T> =>
  await Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`still waiting after ${String(ms)} ms`);
    }),
  ]);

interface Carried {
  readonly agent: string;
  readonly api: Hono;
  readonly exchange: Awaited<ReturnType<typeof carriedOllama>>['exchange'];
}

interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, a fresh agent per schedule
describe.skipIf(serverUrl === undefined)('a carried call start against a closer in flight', () => {
  let w: ConversationWorld;
  let ollama: StandIn;
  const pools: Database[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    const fixture = await createApiFixture('carried_start_race');
    w = await conversationWorld({ fixture, api: fixture.compose() });
  }, 180_000);

  // A held start's call is never sent: ended after its case, so the next one finds the model free.
  afterEach(async () => {
    await w.fixture.db.admin.execute(
      `update public.model_calls set state = 'released', ended_at = clock_timestamp(), drop_state = null
        where business_id = $1 and state = 'dispatched'`,
      [w.fixture.business],
    );
  });

  afterAll(async () => {
    ollama?.open();
    await Promise.allSettled(stops.map(async (stop) => await stop()));
    await Promise.allSettled(pools.map(async (one) => await one.close()));
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  async function carried(agentId?: string, carrierAgent?: string): Promise<Carried> {
    const { fixture } = w;
    const agent =
      agentId ??
      (await fixture.db.app.withBusiness(fixture.business, (tx) => insertAgentActor(tx)));
    const carrier = { agent, people: [w.owner.personId] };
    const one = carriedApi(fixture, carrier);
    pools.push(one.database);
    const broker = await carriedOllama(ollama.origin, {
      agent: carrierAgent ?? agent,
      people: [w.owner.personId],
    });
    stops.push(broker.stop);
    return { agent, api: one.api, exchange: broker.exchange };
  }

  /** The owner's question in a conversation the agent joined on its start. */
  async function question(c: Carried, body: string): Promise<Asked> {
    const opened = await as(c.api, w.owner, 'conversation.start', { body });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    expect(await openCount(asked.conversationId)).toBe(1);
    return asked;
  }

  const openCount = async (conversationId: string) =>
    await w.count(
      `select count(*)::text as n from public.conversation_agent_members
        where conversation_id = $1 and left_at is null`,
      [conversationId],
    );

  const rowsFor = async (conversationId: string) =>
    await w.fixture.db.admin.execute<{ readonly calls: number; readonly carriers: number }>(
      `select (select count(*)::int from public.model_calls where conversation_id = $1) as calls,
              (select count(*)::int from public.model_call_carriers k
                 join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
                where c.conversation_id = $1) as carriers`,
      [conversationId],
    );

  /** Asks on a connection of its own, so the case can watch it wait. */
  const ask = (c: Carried, asked: Asked): { readonly reply: Promise<ConversationReply | null> } => {
    const reader = connect(w.fixture.db.appUrl, { source: 'runtime' });
    pools.push(reader);
    return { reply: c.exchange(reader, w.fixture.business, w.owner.presented, asked) };
  };

  const context = (c: Carried): CommandContext =>
    ({
      carrier: { agent: c.agent, people: [w.owner.personId] },
      session: { personId: w.owner.personId, actorId: w.owner.actorId },
    }) as unknown as CommandContext;

  const PURGE = `update conversations set body_purged_at = clock_timestamp(), purge_operation_id = $3
                  where business_id = $1 and id = $2`;
  const DEACTIVATE = `update actors set active = false, deactivated_at = clock_timestamp()
                       where business_id = $1 and id = $2`;

  /** The closers, each held uncommitted in a transaction of the application role. */
  const closers = {
    leave: async (c: Carried, asked: Asked) => {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'api');
      try {
        return await holdApp(w.fixture.db.appUrl, w.fixture.business, async (tx) => {
          await tx.query(
            'select 1 from conversations where business_id = $1 and id = $2 for update',
            [tx.businessId, asked.conversationId],
          );
          await followModel(tx, context(c), asked.conversationId, null);
        });
      } finally {
        vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
      }
    },
    purge: async (_c: Carried, asked: Asked) =>
      await holdApp(w.fixture.db.appUrl, w.fixture.business, async (tx) => {
        await tx.query(PURGE, [tx.businessId, asked.conversationId, randomUUID()]);
      }),
    deactivation: async (c: Carried) =>
      await holdApp(w.fixture.db.appUrl, w.fixture.business, async (tx) => {
        await tx.query(DEACTIVATE, [tx.businessId, c.agent]);
      }),
  };

  it.each(['leave', 'purge', 'deactivation'] as const)(
    'closer first (%s): the call waits for it, is refused, and nothing is written or sent',
    async (name) => {
      const { db } = w.fixture;
      const c = await carried();
      const asked = await question(c, `Closed first (${name})?`);
      const before = ollama.seen.length;
      const closer = await closers[name](c, asked);
      let asking: { readonly reply: Promise<ConversationReply | null> } | undefined;
      try {
        asking = ask(c, asked);
        await waitersOf(db.admin, closer.pid);
        await closer.letGo();
        expect(await within(10_000, asking.reply)).toMatchObject({
          answered: false,
          code: 'CARRIAGE_UNAVAILABLE',
        });
        expect(await rowsFor(asked.conversationId)).toEqual([{ calls: 0, carriers: 0 }]);
        expect(ollama.seen).toHaveLength(before);
        expect(await openCount(asked.conversationId)).toBe(0);
      } finally {
        await closer.letGo();
        await asking?.reply.catch(() => null);
      }
    },
    60_000,
  );

  /**
   * The call's start as `callModelInConversation` makes it, held open after
   * `carriedIn`: the call and its carriers row are written when it is let go.
   */
  const startHeld = async (c: Carried, asked: Asked) => {
    const started = await holdApp(w.fixture.db.appUrl, w.fixture.business, async (tx) => {
      expect(await carriedIn(tx, asked.conversationId, { agent: c.agent, people: [] })).toBe(true);
    });
    const write = async (tx: Parameters<typeof carriedIn>[0]) => {
      const callId = await dispatchedCall(tx, asked);
      await writeCarriers(tx, callId, { agent: c.agent, people: [] });
    };
    return { started, write };
  };

  /** A closer on a connection of its own, sent now; answers when it commits. */
  const closeNow = (name: 'purge' | 'deactivation', c: Carried, asked: Asked) => {
    const closerDb = connect(w.fixture.db.appUrl, { source: 'runtime' });
    pools.push(closerDb);
    return closerDb.withBusiness(w.fixture.business, async (tx) => {
      await (name === 'purge'
        ? tx.query(PURGE, [tx.businessId, asked.conversationId, randomUUID()])
        : tx.query(DEACTIVATE, [tx.businessId, c.agent]));
    });
  };

  it.each(['purge', 'deactivation'] as const)(
    'call first (%s): the closer waits for the call, and closes the membership after its commit',
    async (name) => {
      const { db } = w.fixture;
      const c = await carried();
      const asked = await question(c, `Call first (${name})?`);
      const { started, write } = await startHeld(c, asked);
      const closing = closeNow(name, c, asked);
      try {
        await waitersOf(db.admin, started.pid);
        await started.letGo(write);
        await closing;
        expect(await rowsFor(asked.conversationId)).toEqual([{ calls: 1, carriers: 1 }]);
        expect(await openCount(asked.conversationId)).toBe(0);
      } finally {
        await started.letGo();
        await closing.catch(() => null);
      }
    },
    60_000,
  );

  it.each(['purge', 'deactivation'] as const)(
    'clock (%s): the close time a closer records is read after it waited on the call',
    async (name) => {
      const { db } = w.fixture;
      const c = await carried();
      const asked = await question(c, `Clock (${name})?`);
      const { started, write } = await startHeld(c, asked);
      const closing = closeNow(name, c, asked);
      try {
        await waitersOf(db.admin, started.pid);
        await started.letGo(write);
        await closing;
        const [order] = await db.admin.execute<{ readonly closed_after_start: boolean }>(
          `select m.left_at >= c.started_at as closed_after_start
             from public.conversation_agent_members m
             join public.model_calls c on c.conversation_id = m.conversation_id
            where m.conversation_id = $1`,
          [asked.conversationId],
        );
        expect(
          order?.closed_after_start,
          'left_at was read before the close waited on the call: the record shows the call started after the membership closed',
        ).toBe(true);
      } finally {
        await started.letGo();
        await closing.catch(() => null);
      }
    },
    60_000,
  );

  it('crash: a call that dies after its read writes nothing, and the closer goes on', async () => {
    const { db } = w.fixture;
    const c = await carried();
    const asked = await question(c, 'Crashed start?');
    const { started, write } = await startHeld(c, asked);
    const closing = closeNow('purge', c, asked);
    try {
      await waitersOf(db.admin, started.pid);
      await expect(
        started.letGo(async (tx) => {
          await write(tx);
          throw new Error('the asking process died');
        }),
      ).rejects.toThrow('the asking process died');
      await closing;
      expect(await rowsFor(asked.conversationId)).toEqual([{ calls: 0, carriers: 0 }]);
      expect(await openCount(asked.conversationId)).toBe(0);
    } finally {
      await started.letGo().catch(() => null);
      await closing.catch(() => null);
    }
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('a model pick and a call at once: both finish, neither is aborted', async () => {
    const { db } = w.fixture;
    const c = await carried();
    const asked = await question(c, 'Pick and ask at once?');
    // The conversation row, held as any command on it holds it, so the pick queues on it
    // first and the call (past `carriedIn`) queues behind on its key check.
    const row = await hold(db, async (execute) => {
      await execute('select 1 from public.conversations where id = $1 for update', [
        asked.conversationId,
      ]);
    });
    vi.stubEnv('OPS_AGENT_PROVIDER', 'api');
    let picking: Promise<unknown> | undefined;
    let asking: { readonly reply: Promise<ConversationReply | null> } | undefined;
    try {
      picking = as(c.api, w.owner, 'conversation.set_model', {
        conversationId: asked.conversationId,
        model: null,
      });
      await waitersOf(db.admin, row.pid, 1);
      asking = ask(c, asked);
      // The call, past `carriedIn` (its membership held for share), queues on the row's key check.
      await blockedIn(db.admin, 'insert into public.model_calls');
      await row.letGo();
      const outcomes = await Promise.allSettled([
        within(20_000, picking),
        within(20_000, asking.reply),
      ]);
      const failures = outcomes.flatMap((one, at) =>
        one.status === 'rejected'
          ? [`${at === 0 ? 'the pick' : 'the call'}: ${String((one.reason as Error).message)}`]
          : [],
      );
      expect(failures, 'a pick and a call at once deadlock: one is aborted').toEqual([]);
      const [picked, replied] = outcomes.map((one) =>
        one.status === 'fulfilled' ? one.value : undefined,
      );
      expect(picked).toMatchObject({ status: 200 });
      expect(replied).toMatchObject({ answered: true, body: says(QWEN) });
      expect(await openCount(asked.conversationId)).toBe(0);
    } finally {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
      await row.letGo();
      await picking?.catch(() => null);
      await asking?.reply.catch(() => null);
    }
  }, 60_000);

  it.each([
    ['carried', 'ollama', 1],
    ['not carried', 'api', 0],
  ] as const)(
    'two picks at once (the second %s, named in capitals): at most one open membership',
    async (_name, provider, open) => {
      const { db } = w.fixture;
      const c = await carried();
      const asked = await question(c, `Two picks (${provider})?`);
      // The first pick, carried, held before its commit with the conversation's row locked.
      const first = await holdApp(db.appUrl, w.fixture.business, async (tx) => {
        await tx.query(
          'select 1 from conversations where business_id = $1 and id = $2 for update',
          [tx.businessId, asked.conversationId],
        );
        await followModel(tx, context(c), asked.conversationId, null);
      });
      vi.stubEnv('OPS_AGENT_PROVIDER', provider);
      let second: Promise<{ readonly status: number }> | undefined;
      try {
        second = as(c.api, w.owner, 'conversation.set_model', {
          conversationId: asked.conversationId.toUpperCase(),
          model: null,
        });
        await waitersOf(db.admin, first.pid);
        await first.letGo();
        expect((await second).status).toBe(200);
        expect(await openCount(asked.conversationId)).toBe(open);
      } finally {
        vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
        await first.letGo();
        await second?.catch(() => null);
      }
    },
    60_000,
  );

  it("scope: a broker carrying another business's agent carries nothing here", async () => {
    const { db } = w.fixture;
    const beta = await carriageBusiness(db.app, `beta_${randomUUID().slice(0, 8)}`);
    const c = await carried(undefined, beta.agent.actor);
    const asked = await question(c, 'Whose carrier?');
    const before = ollama.seen.length;
    expect(await within(10_000, ask(c, asked).reply)).toMatchObject({
      answered: false,
      code: 'CARRIAGE_UNAVAILABLE',
    });
    expect(await rowsFor(asked.conversationId)).toEqual([{ calls: 0, carriers: 0 }]);
    expect(ollama.seen).toHaveLength(before);
  }, 60_000);

  it('upper case: a conversation and message named in capitals are carried as themselves', async () => {
    const c = await carried();
    const asked = await question(c, 'Capitals carried?');
    const before = ollama.seen.length;
    const shouted = {
      conversationId: asked.conversationId.toUpperCase(),
      messageId: asked.messageId.toUpperCase(),
    };
    expect(await within(10_000, ask(c, shouted).reply)).toMatchObject({
      answered: true,
      body: says(QWEN),
    });
    expect(await rowsFor(asked.conversationId)).toEqual([{ calls: 1, carriers: 1 }]);
    expect(ollama.seen).toHaveLength(before + 1);
  }, 60_000);
});
