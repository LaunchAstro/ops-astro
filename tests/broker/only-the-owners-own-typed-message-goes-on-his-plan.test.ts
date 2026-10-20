// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world: the offer, P4 each way, the lock race and the plan's words */
//
// #2175, money rule P4 in the side chat: the owner picks one of his plan's
// models and his own typed message goes on his plan, through the plan's
// route only, settled at nothing as a subscription. Everyone else is told
// why the plan is not theirs: a member sees it unavailable, a conversation on
// a client's task never lists it, and a page task the owner did not create
// keeps the plan from the message (`LOCAL_MODEL_REQUIRED`). The broker asks
// again under the membership's lock, after its wait and on a connection of its
// own, so a caller who is not the owner there is refused by name with nothing
// written. The plan's refusals reach the chat in
// their own words: before the send nothing was sent, after it the call is
// held and nothing was retried; a model the plan refused shows unavailable.
//
// The panel's path is the product's own (`conversationExchange`); custody is a
// stand-in that answers as the M5's plan custody does, recording each request.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogue,
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_PROVIDER,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  conversationExchange,
  type ConversationReply,
} from '../../packages/core-commands/src/index.ts';
import {
  callModelInConversation,
  type Broker,
  type BrokerRoute,
  type Custody,
  type CustodyOutcome,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { composedWith } from '../api/aw-03-exchange-fixture.ts';
import { conversationWorld, detail, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { createApiFixture } from '../api/fixture.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import { carriedApi } from '../api/carried-exchange-fixture.ts';
import { post, authorised, tokenFor } from '../api/fixture.ts';
import { personPath } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const LUNA = 'gpt-6.1-luna';
const SOL = 'gpt-6.1-sol';

const PLAN_ROUTE: BrokerRoute = {
  key: 'chatgpt_plan',
  reach: 'cloud',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialRef: 'carried',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 2,
};
const OLLAMA_ROUTE: BrokerRoute = {
  ...PLAN_ROUTE,
  key: 'm5_ollama',
  reach: 'local',
  provider: OLLAMA_PROVIDER,
  credentialKind: 'api_key',
  ceiling: 2,
};

/** A completed Responses answer, folded, as the M5's plan custody hands it back. */
const completed = (model: string, text: string): CustodyOutcome => ({
  kind: 'answered',
  started: true,
  // A carried custody names no kind of its own: the route's is the call's.
  credentialKind: 'api_key',
  account: null,
  outbound: {
    ok: true,
    status: 200,
    mediaType: 'application/json',
    body: JSON.stringify({
      model,
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 12, output_tokens: 5 },
    }),
  },
});

type Answer = (request: OutboundRequest) => CustodyOutcome;

interface PlanCustody extends Custody {
  readonly sent: OutboundRequest[];
  answer: Answer;
}

/** Custody as the M5's plan custody answers, every request kept, none checked here. */
function planCustody(): PlanCustody {
  const sent: OutboundRequest[] = [];
  const custody: PlanCustody = {
    pid: 0,
    sent,
    answer: (request) => completed(String(JSON.parse(request.body).model), 'Two tasks today.'),
    dispatch: async (_ref, request) => {
      sent.push(request);
      return await Promise.resolve(custody.answer(request));
    },
    describe: async () => await Promise.resolve(null),
    stderr: () => '',
    raw: async () => await Promise.resolve({}),
    kill: () => {},
    stop: async () => {},
  };
  return custody;
}

interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

const askedOf = (answer: Awaited<ReturnType<ConversationWorld['as']>>): Asked => ({
  conversationId: String(detail(answer)['conversationId']),
  messageId: String(detail(answer)['messageId']),
});

interface Read {
  readonly models: readonly { readonly id: string }[];
  readonly unavailable?: readonly { readonly id: string; readonly code: string }[];
}

// oxlint-disable-next-line max-lines-per-function -- one world, P4 each way and the plan's words
describe.skipIf(serverUrl === undefined)("the owner's typed message on his plan", () => {
  let w: ConversationWorld;
  let custody: PlanCustody;
  let broker: Omit<Broker, 'audit'>;
  let ask: (asked: Asked, member?: Member) => Promise<ConversationReply | null>;

  /** `member` holds `role` from now on: a new membership, the old one ended. */
  const holdsRole = async (member: Member, role: 'owner' | 'member'): Promise<void> => {
    const { db, business } = w.fixture;
    await db.admin.execute(
      `update public.memberships set active = false, ended_at = clock_timestamp()
        where business_id = $1 and person_id = $2 and active`,
      [business, member.personId],
    );
    await db.admin.execute(
      `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
       values ($1, $2, $3, $4, true, clock_timestamp())`,
      [business, randomUUID(), member.personId, role],
    );
  };

  const read = async (member: Member, conversationId?: string): Promise<Read> =>
    (await w.as(member, 'conversation.models', conversationId ? { conversationId } : {}))
      .body as unknown as Read;

  const calls = async (conversationId: string): Promise<readonly Record<string, unknown>[]> =>
    await w.fixture.db.admin.execute(
      `select state, route_key, route_reach, credential_kind, reserved_minor, model_id,
              operation_key, provider_code
         from public.model_calls where conversation_id = $1 order by started_at`,
      [conversationId],
    );

  beforeAll(async () => {
    const fixture = await createApiFixture('plan_side_chat');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    vi.stubEnv('MODEL_BROKER_CARRIER', JSON.stringify({ agent: randomUUID(), people: [] }));
    vi.stubEnv('MODEL_BROKER_ROUTES', JSON.stringify([OLLAMA_ROUTE, PLAN_ROUTE]));
    custody = planCustody();
    const plan = catalogueOf('ollama', false, true);
    broker = {
      custody,
      operations: catalogue([OLLAMA_CONVERSATION, CHATGPT_PLAN_CONVERSATION]),
      providers: new Map([
        [OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }],
        [CHATGPT_PLAN_PROVIDER, plan.providers.get(CHATGPT_PLAN_PROVIDER)!],
      ]),
      routes: [OLLAMA_ROUTE, PLAN_ROUTE],
      installation: 'here',
    };
    const exchange = conversationExchange(broker);
    ask = async (asked, member = w.owner) =>
      await exchange(fixture.db.app, fixture.business, member.presented, asked);
    await holdsRole(w.owner, 'owner');
  }, 180_000);

  afterAll(async () => {
    await w?.drop();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    custody.answer = (request) =>
      completed(String(JSON.parse(request.body).model), 'Two tasks today.');
    await holdsRole(w.owner, 'owner');
  });

  it('the owner is offered both plan models; his typed message goes on the plan as he chose', async () => {
    const offered = await read(w.owner);
    expect(offered.models.map((model) => model.id)).toEqual(expect.arrayContaining([LUNA, SOL]));
    const asked = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'What is due today?', model: SOL }),
    );
    const sent = custody.sent.length;
    expect(await ask(asked)).toMatchObject({ answered: true, body: 'Two tasks today.' });
    expect(custody.sent).toHaveLength(sent + 1);
    const request = custody.sent.at(-1)!;
    expect(request.destination).toBe(CHATGPT_PLAN_PROVIDER);
    expect(JSON.parse(request.body)).toMatchObject({ model: SOL, store: false });
    expect(chatOf(request)).toBe(request);
    expect(await calls(asked.conversationId)).toEqual([
      expect.objectContaining({
        state: 'settled',
        route_key: 'chatgpt_plan',
        route_reach: 'cloud',
        credential_kind: 'subscription',
        reserved_minor: 0,
        model_id: SOL,
        operation_key: CHATGPT_PLAN_CONVERSATION.key,
      }),
    ]);
    const kept = await read(w.owner, asked.conversationId);
    expect((kept as unknown as { chosen: string }).chosen).toBe(SOL);
  });

  it('a member sees the plan unavailable, not theirs, and cannot choose it', async () => {
    const offered = await read(w.colleague);
    expect(offered.models.map((model) => model.id)).not.toContain(LUNA);
    expect(offered.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: LUNA, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' }),
      ]),
    );
    const start = await w.as(w.colleague, 'conversation.start', { body: 'Hi', model: LUNA });
    expect(start.status).toBe(422);
  });

  it("a conversation on a client's task never lists the plan", async () => {
    const { db, business } = w.fixture;
    const clientId = randomUUID();
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    await addClient(db.app, business, clientId, w.owner);
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'A client’s task' } });
    await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    const scope = { kind: 'task', id: String(made.body['recordId']) };
    const opened = askedOf(await w.as(w.owner, 'conversation.start', { body: 'Hi', scope }));
    const offered = await read(w.owner, opened.conversationId);
    const listed = [...offered.models, ...(offered.unavailable ?? [])].map((model) => model.id);
    expect(listed).not.toContain(LUNA);
    expect(listed).not.toContain(SOL);
  });

  it('a page task the owner did not create keeps the plan from the message: nothing sent', async () => {
    await holdsRole(w.owner, 'member');
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'Made as a member' } });
    await holdsRole(w.owner, 'owner');
    const scope = { kind: 'task', id: String(made.body['recordId']) };
    const asked = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'And this?', scope, model: LUNA }),
    );
    const sent = custody.sent.length;
    expect(await ask(asked)).toMatchObject({ answered: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(custody.sent).toHaveLength(sent);
    expect(await calls(asked.conversationId)).toEqual([]);
  });

  it('the broker asks the role again under its lock: not the owner there, refused by name, nothing written', async () => {
    const asked = askedOf(await w.as(w.owner, 'conversation.start', { body: 'Due?', model: LUNA }));
    await holdsRole(w.owner, 'member');
    const sent = custody.sent.length;
    const result = await callModelInConversation(
      w.fixture.db.app,
      w.fixture.business,
      { actorId: w.owner.actorId, delegationId: null, attendedByPersonId: w.owner.personId },
      {
        conversation: {
          id: asked.conversationId,
          businessId: w.fixture.business,
          ownerPersonId: w.owner.personId,
        },
        messageId: asked.messageId,
        operation: CHATGPT_PLAN_CONVERSATION.key,
        model: LUNA,
        fields: [{ name: 'message', source: 'outside', value: 'Due?' }],
        plan: { authors: [w.owner.actorId], page: null, sources: [] },
      },
      { ...broker, audit: async () => {} },
    );
    expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(custody.sent).toHaveLength(sent);
    expect(await calls(asked.conversationId)).toEqual([]);
  });

  it('an owner membership ended while the broker waits on its lock: read after the wait, refused, nothing sent', async () => {
    const { db, business } = w.fixture;
    const asked = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'Due now?', model: LUNA }),
    );
    const held = await hold(
      db,
      async (execute) => {
        await execute(
          `select id from public.memberships
            where business_id = $1 and person_id = $2 and active for update`,
          [business, w.owner.personId],
        );
      },
      async (execute) => {
        await execute(
          `update public.memberships set active = false, ended_at = clock_timestamp()
            where business_id = $1 and person_id = $2 and active`,
          [business, w.owner.personId],
        );
      },
    );
    const sent = custody.sent.length;
    const asking = callModelInConversation(
      db.app,
      business,
      { actorId: w.owner.actorId, delegationId: null, attendedByPersonId: w.owner.personId },
      {
        conversation: {
          id: asked.conversationId,
          businessId: business,
          ownerPersonId: w.owner.personId,
        },
        messageId: asked.messageId,
        operation: CHATGPT_PLAN_CONVERSATION.key,
        model: LUNA,
        fields: [{ name: 'message', source: 'outside', value: 'Due now?' }],
        plan: { authors: [w.owner.actorId], page: null, sources: [] },
      },
      { ...broker, audit: async () => {} },
    );
    await waiterOf(db, held);
    await held.letGo();
    expect(await asking).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(custody.sent).toHaveLength(sent);
    expect(await calls(asked.conversationId)).toEqual([]);
  });

  it('a refusal before the send says so and nothing was sent; after the write it is held, never retried', async () => {
    custody.answer = () => ({
      kind: 'refused',
      started: false,
      code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    });
    const before = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'Sign-in?', model: LUNA }),
    );
    expect(await ask(before)).toMatchObject({
      answered: false,
      code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    });
    custody.answer = () => ({
      kind: 'answered',
      started: true,
      credentialKind: 'api_key',
      account: null,
      outbound: { ok: false, fault: 'status', status: 429 },
    });
    const after = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'Allowance?', model: LUNA }),
    );
    const sent = custody.sent.length;
    expect(await ask(after)).toMatchObject({
      answered: false,
      code: 'SUBSCRIPTION_PLAN_ALLOWANCE',
    });
    expect(custody.sent).toHaveLength(sent + 1);
    expect(await calls(after.conversationId)).toEqual([
      expect.objectContaining({ state: 'liability_unknown', provider_code: 'http_429' }),
    ]);
  });

  it('a model the plan refused shows unavailable with that reason; the other stays offered', async () => {
    custody.answer = (request) =>
      String(JSON.parse(request.body).model) === SOL
        ? {
            kind: 'answered',
            started: true,
            credentialKind: 'api_key',
            account: null,
            outbound: { ok: false, fault: 'status', status: 403 },
          }
        : completed(LUNA, 'Fine.');
    const asked = askedOf(await w.as(w.owner, 'conversation.start', { body: 'Sol?', model: SOL }));
    expect(await ask(asked)).toMatchObject({ answered: false, code: 'SUBSCRIPTION_NOT_ELIGIBLE' });
    const offered = await read(w.owner);
    expect(offered.models.map((model) => model.id)).toContain(LUNA);
    expect(offered.models.map((model) => model.id)).not.toContain(SOL);
    expect(offered.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SOL, code: 'SUBSCRIPTION_NOT_ELIGIBLE' }),
      ]),
    );
  });
  it('plan choices reveal no other persons or businesses conversation', async () => {
    const asked = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'Private owner turn', model: LUNA }),
    );
    const otherPerson = await w.as(w.colleague, 'conversation.models', {
      conversationId: asked.conversationId,
    });
    const madeUp = await w.as(w.colleague, 'conversation.models', { conversationId: randomUUID() });
    expect(otherPerson).toEqual(madeUp);
    expect(otherPerson.body).toMatchObject({ refused: true, code: 'NOT_FOUND' });
    const rows = await w.fixture.db.app.withBusiness(
      randomUUID(),
      async (tx) =>
        await tx.query('select id from public.conversations where id = $1', [asked.conversationId]),
    );
    expect(rows).toEqual([]);
  });

  it('switching to a plan model keeps the M5 carrier joined', async () => {
    const carrier = { agent: w.fixture.agentActorId, people: [w.owner.personId] };
    const carried = carriedApi(w.fixture, carrier);
    try {
      const send = async (name: string, body: Record<string, unknown>) =>
        await post(
          carried.api,
          personPath(name),
          { operationId: randomUUID(), ...body },
          authorised(await tokenFor(w.owner.presented.subject)),
        );
      const asked = askedOf(await send('conversation.start', { body: 'Start locally' }));
      const members = async () =>
        await w.fixture.db.admin.execute(
          'select agent_actor_id from public.conversation_agent_members where conversation_id = $1 and left_at is null',
          [asked.conversationId],
        );
      expect(await members()).toHaveLength(1);
      expect(
        (
          await send('conversation.set_model', {
            conversationId: asked.conversationId,
            model: LUNA,
          })
        ).status,
      ).toBe(200);
      const next = askedOf(
        await send('conversation.message', {
          conversationId: asked.conversationId,
          body: 'Now on the plan',
        }),
      );
      const result = await conversationExchange({ ...broker, carrier })(
        w.fixture.db.app,
        w.fixture.business,
        w.owner.presented,
        next,
      );
      expect({ openMembers: (await members()).length, result }).toMatchObject({
        openMembers: 1,
        result: { answered: true },
      });
    } finally {
      await carried.database.close();
    }
  });

  it('a refused plan model is retained on its call and becomes unavailable', async () => {
    custody.answer = () => ({
      kind: 'answered',
      started: true,
      credentialKind: 'api_key',
      account: null,
      outbound: { ok: false, fault: 'status', status: 403 },
    });
    const asked = askedOf(
      await w.as(w.owner, 'conversation.start', { body: 'Independent refusal', model: LUNA }),
    );
    expect(await ask(asked)).toMatchObject({ answered: false, code: 'SUBSCRIPTION_NOT_ELIGIBLE' });
    const rows = await calls(asked.conversationId);
    const offered = await read(w.owner, asked.conversationId);
    expect({ rows, offered }).toMatchObject({
      rows: [expect.objectContaining({ model_id: LUNA, provider_code: 'http_403' })],
      offered: {
        unavailable: expect.arrayContaining([
          expect.objectContaining({ id: LUNA, code: 'SUBSCRIPTION_NOT_ELIGIBLE' }),
        ]),
      },
    });
    expect(offered.models.map((m) => m.id)).not.toContain(LUNA);
  });
});
