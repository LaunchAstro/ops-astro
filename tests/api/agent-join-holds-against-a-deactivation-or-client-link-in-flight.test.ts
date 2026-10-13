// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world and the join's schedules against each writer */
//
// The carrier's agent joining a person's conversation races the agent's
// deactivation and a client link on the conversation's page task. The join is
// the shipped command (`conversation.start`) where it waits, or the product's
// `followModel` under the conversation's row lock, as `conversation.set_model`
// runs it, held open on a connection of its own where it must go first (a
// person's commands queue on the business's audit chain from their start, so
// two commands never overlap). Each schedule is set by what `pg_stat_activity`
// shows. Whichever commits first, no membership is left open for an inactive
// agent or on a client's task. Also: a deactivation that rolls back leaves the
// join, its joining time read after the wait; a carrier naming another
// business's agent joins nothing; a pick naming the conversation in capitals
// keeps the one membership.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { carriageBusiness } from './carriage-fixture.ts';
import { carriedApi, holdApp, type HeldApp, waitersOf } from './carried-exchange-fixture.ts';
import { personPath } from './controls-fixture.ts';
import { authorised, createApiFixture, post, tokenFor, type Answer } from './fixture.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { followModel } from '../../packages/core-commands/src/commands/conversation-agents.ts';
import type { CommandContext } from '../../packages/core-commands/src/commands/context.ts';
import { slotOf, TASK_SPINE } from '../../packages/core-records/src/index.ts';

const CLIENT = slotOf(TASK_SPINE, 'client');

const serverUrl = databaseUrlFromEnvironment();

const as = async (api: Hono, member: Member, name: string, body: Record<string, unknown>) =>
  await post(
    api,
    personPath(name),
    { operationId: randomUUID(), ...body },
    authorised(await tokenFor(member.presented.subject)),
  );

const conversationOf = (answer: Answer): string => String(detail(answer)['conversationId']);

interface Carried {
  readonly agent: string;
  readonly api: Hono;
  readonly other: Hono;
  readonly pools: readonly Database[];
}

// eslint-disable-next-line max-lines-per-function -- one world, a fresh agent per schedule
describe.skipIf(serverUrl === undefined)('the agent joins against a writer in flight', () => {
  let w: ConversationWorld;
  const pools: Database[] = [];

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const fixture = await createApiFixture('agent_join_race');
    w = await conversationWorld({ fixture, api: fixture.compose() });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'write');
      await grantTo(tx, w.owner, 'share');
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(pools.map(async (one) => await one.close()));
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** A fresh active agent, carried for the owner, behind two composition roots on pools of their own. */
  async function carried(agentId?: string): Promise<Carried> {
    const { fixture } = w;
    const agent =
      agentId ??
      (await fixture.db.app.withBusiness(fixture.business, (tx) => insertAgentActor(tx)));
    const carrier = { agent, people: [w.owner.personId] };
    const one = carriedApi(fixture, carrier);
    const two = carriedApi(fixture, carrier);
    pools.push(one.database, two.database);
    return { agent, api: one.api, other: two.api, pools: [one.database, two.database] };
  }

  const memberships = async (conversationId: string) =>
    await w.fixture.db.admin.execute<{ readonly open: boolean; readonly joined_at: string }>(
      `select left_at is null as open, joined_at::text from public.conversation_agent_members
        where conversation_id = $1 order by joined_at`,
      [conversationId],
    );

  const deactivate =
    'update public.actors set active = false, deactivated_at = clock_timestamp() where id = $1';

  it('deactivation first: the join waits for it, and joins nothing', async () => {
    const { db } = w.fixture;
    const c = await carried();
    const writer = await hold(db, async (execute) => {
      await execute(deactivate, [c.agent]);
    });
    const starting = as(c.api, w.owner, 'conversation.start', { body: 'Join after?' });
    try {
      await waitersOf(db.admin, writer.pid);
      await writer.letGo();
      const answer = await starting;
      expect(answer.status).toBe(200);
      expect(await memberships(conversationOf(answer))).toEqual([]);
    } finally {
      await writer.letGo();
      await starting.catch(() => null);
    }
  }, 60_000);

  /** A conversation of the owner's that the agent joined and then left: the next carried pick joins it. */
  async function leftConversation(c: Carried, body: Record<string, unknown> = {}): Promise<string> {
    const conversationId = conversationOf(
      await as(c.api, w.owner, 'conversation.start', { body: 'Left, then?', ...body }),
    );
    vi.stubEnv('OPS_AGENT_PROVIDER', 'api');
    try {
      const left = await as(c.api, w.owner, 'conversation.set_model', {
        conversationId,
        model: null,
      });
      expect(left.status).toBe(200);
    } finally {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    }
    expect((await memberships(conversationId)).map((one) => one.open)).toEqual([false]);
    return conversationId;
  }

  /**
   * The join as `conversation.set_model` makes it, stopped before its commit:
   * the conversation's row locked for update, then the product's `followModel`
   * on a carried model, in a transaction of the application role held open.
   */
  const joinHeld = async (c: Carried, conversationId: string) =>
    await holdApp(w.fixture.db.appUrl, w.fixture.business, async (tx) => {
      await tx.query('select 1 from conversations where business_id = $1 and id = $2 for update', [
        tx.businessId,
        conversationId,
      ]);
      const context = {
        carrier: { agent: c.agent, people: [w.owner.personId] },
        session: { personId: w.owner.personId, actorId: w.owner.actorId },
      } as unknown as CommandContext;
      await followModel(tx, context, conversationId, null);
    });

  it('join first: the deactivation waits for it, and closes what it joined', async () => {
    const { db, business } = w.fixture;
    const c = await carried();
    const conversationId = await leftConversation(c);
    const joiner = await joinHeld(c, conversationId);
    const deactivator = connect(db.appUrl, { source: 'runtime' });
    pools.push(deactivator);
    let deactivating: Promise<unknown> | undefined;
    try {
      deactivating = deactivator.withBusiness(business, async (tx) => {
        await tx.query(deactivate, [c.agent]);
      });
      // The deactivation waits on the join, which holds the agent's row for share.
      await waitersOf(db.admin, joiner.pid);
      await joiner.letGo();
      await deactivating;
      expect((await memberships(conversationId)).map((one) => one.open)).toEqual([false, false]);
    } finally {
      await joiner.letGo();
      await deactivating?.catch(() => null);
    }
  }, 60_000);

  it('crash: a deactivation that rolls back leaves the join, its time read after the wait', async () => {
    const { db } = w.fixture;
    const c = await carried();
    let rolledBackAt = '';
    const writer = await hold(
      db,
      async (execute) => {
        await execute(deactivate, [c.agent]);
      },
      async (execute) => {
        rolledBackAt =
          (await execute<{ at: string }>('select clock_timestamp()::text as at'))[0]?.at ?? '';
        throw new Error('the deactivating process died');
      },
    );
    const starting = as(c.api, w.owner, 'conversation.start', { body: 'Still joined?' });
    try {
      await waitersOf(db.admin, writer.pid);
      await expect(writer.letGo()).rejects.toThrow('the deactivating process died');
      const answer = await starting;
      expect(answer.status).toBe(200);
      const [one, ...more] = await memberships(conversationOf(answer));
      expect(more).toEqual([]);
      expect(one?.open).toBe(true);
      const [after] = await db.admin.execute<{ readonly after: boolean }>(
        'select $1::text::timestamptz >= $2::text::timestamptz as after',
        [one?.joined_at, rolledBackAt],
      );
      expect(after?.after, 'joined_at was read before the wait on the agent row').toBe(true);
    } finally {
      await writer.letGo().catch(() => null);
      await starting.catch(() => null);
    }
  }, 60_000);

  /** An internal task of the owner's, answered with its id and revision. */
  async function internalTask(): Promise<{ readonly id: string; readonly revision: unknown }> {
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'Internal work' } });
    expect(made.status).toBe(200);
    return { id: String(made.body['recordId']), revision: made.body['revision'] };
  }

  it('client link first: the join on its task waits for it, and joins nothing', async () => {
    const { db, business } = w.fixture;
    const c = await carried();
    const task = await internalTask();
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const conversationId = await leftConversation(c, { scope: { kind: 'task', id: task.id } });
    // The link's write as `task.set_party` makes it (the task's client slot), held uncommitted.
    const link = await holdApp(db.appUrl, business, async (tx) => {
      await tx.query('select 1 from records where business_id = $1 and id = $2 for update', [
        tx.businessId,
        task.id,
      ]);
      await tx.query(
        `update records set data = jsonb_set(data, '{client}', to_jsonb($3::text))
          where business_id = $1 and id = $2`,
        [tx.businessId, task.id, clientId],
      );
    });
    let joining: Promise<HeldApp<void>> | undefined;
    try {
      joining = joinHeld(c, conversationId);
      // The join's read of the task, for share, waits on the link.
      await waitersOf(db.admin, link.pid);
      await link.letGo();
      const [linked] = await db.admin.execute<{ readonly client: string | null }>(
        `select ${CLIENT}::text as client from public.records where id = $1`,
        [task.id],
      );
      expect(linked?.client).toBe(clientId);
      const joiner = await joining;
      await joiner.letGo();
      expect((await memberships(conversationId)).map((one) => one.open)).toEqual([false]);
    } finally {
      await link.letGo();
      await (await joining?.catch(() => null))?.letGo();
    }
  }, 60_000);

  it("join first: a client link that waited on it leaves no open membership on the client's task", async () => {
    const { db, business } = w.fixture;
    const c = await carried();
    const task = await internalTask();
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const conversationId = await leftConversation(c, { scope: { kind: 'task', id: task.id } });
    const joiner = await joinHeld(c, conversationId);
    let linking: Promise<Answer> | undefined;
    try {
      linking = as(c.other, w.owner, 'task.set_party', {
        recordId: task.id,
        expectedRevision: task.revision,
        fields: { client: clientId },
      });
      // The link waits on the task row the join holds for share.
      await waitersOf(db.admin, joiner.pid);
      await joiner.letGo();
      expect((await linking).status).toBe(200);
      expect(
        (await memberships(conversationId)).filter((one) => one.open),
        'an open membership on a conversation whose task now has a client: nothing closes it on the link',
      ).toEqual([]);
    } finally {
      await joiner.letGo();
      await linking?.catch(() => null);
    }
  }, 60_000);

  it("scope: a carrier naming another business's agent joins nothing here", async () => {
    const { db } = w.fixture;
    const beta = await carriageBusiness(db.app, `beta_${randomUUID().slice(0, 8)}`);
    const c = await carried(beta.otherAgent.actor);
    const answer = await as(c.api, w.owner, 'conversation.start', { body: 'Whose agent?' });
    expect(answer.status).toBe(200);
    expect(await memberships(conversationOf(answer))).toEqual([]);
    expect(
      await w.count(
        `select count(*)::text as n from public.conversation_agent_members where agent_actor_id = $1`,
        [beta.otherAgent.actor],
      ),
    ).toBe(0);
  }, 60_000);

  it('upper case: a start and a model pick naming the conversation in capitals keep one open membership', async () => {
    const c = await carried();
    const answer = await as(c.api, w.owner, 'conversation.start', { body: 'CAPITALS' });
    const conversationId = conversationOf(answer);
    expect(conversationId).toBe(conversationId.toLowerCase());
    const picked = await as(c.other, w.owner, 'conversation.set_model', {
      conversationId: conversationId.toUpperCase(),
      model: null,
    });
    expect(picked.status).toBe(200);
    expect((await memberships(conversationId)).map((one) => one.open)).toEqual([true]);
  }, 60_000);
});
