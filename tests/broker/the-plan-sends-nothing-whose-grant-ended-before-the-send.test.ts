// SPDX-License-Identifier: AGPL-3.0-only
//
// S2100-1: a grant the chat's context was read under (`run:write` listing the bound pages, or
// the conversation's) ended before the plan call is written: nothing is sent. Standing, the
// call names the page. The exchange is the product's; custody records each request.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  catalogue,
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_PROVIDER,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { conversationExchange } from '../../packages/core-commands/src/index.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import type {
  BrokerRoute,
  Custody,
  OutboundRequest,
} from '../../packages/core-custody/src/index.ts';
import {
  bindPartySite,
  revokeGrant,
  type Database,
} from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';

const serverUrl = databaseUrlFromEnvironment();

const PLAN: BrokerRoute = {
  key: 'chatgpt_plan',
  reach: 'cloud',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialRef: 'carried',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 2,
};
const LOCAL: BrokerRoute = {
  ...PLAN,
  key: 'm5_ollama',
  reach: 'local',
  provider: OLLAMA_PROVIDER,
  credentialKind: 'api_key',
};
const PLAN_ADAPTER = catalogueOf('ollama', false, true).providers.get(CHATGPT_PLAN_PROVIDER)!;
const PAGE = 'https://revocation-marker.example/about';

let db: FreshDatabase;
let business: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
  vi.stubEnv('MODEL_BROKER_CARRIER', JSON.stringify({ agent: randomUUID(), people: [] }));
  vi.stubEnv('MODEL_BROKER_ROUTES', JSON.stringify([LOCAL, PLAN]));
  db = await createFreshDatabase({ part: 'plan2100revoke' });
  business = await insertBusiness(db.app, `p${randomUUID().slice(0, 8)}`);
  await installSpine(db.app, business);
  const operator = await enrol(db.app, business, 'operator');
  const site = {
    partyId: null,
    repository: `own/site-${randomUUID().slice(0, 8)}`,
    defaultBranch: 'main',
    project: `prj_${randomUUID().slice(0, 8)}`,
    pages: [{ pageUrl: PAGE, path: 'src/pages/about.md' }],
  };
  const bound = await db.app.withBusiness(business, (tx) =>
    bindPartySite(tx, site, operator.actorId),
  );
  expect(bound).toEqual({ ok: true });
});

afterAll(async () => await db?.drop());

/** Custody that records each request and answers as the plan's custody does. */
function recording(sent: OutboundRequest[]): Custody {
  const output = [{ type: 'message', content: [{ type: 'output_text', text: 'A plan.' }] }];
  const usage = { input_tokens: 12, output_tokens: 5 };
  const body = JSON.stringify({ model: 'gpt-6.1-luna', output, usage });
  const outbound = { ok: true, status: 200, mediaType: 'application/json', body };
  const answer = { kind: 'answered', started: true, credentialKind: 'api_key', outbound };
  const dispatch = (_ref: unknown, request: OutboundRequest) => {
    sent.push(request);
    return Promise.resolve({ ...answer, account: null });
  };
  return { describe: () => Promise.resolve(null), dispatch } as unknown as Custody;
}

/** A new owner with business-wide `conversation:write` and `run:write`, and their typed message. */
async function anOwner() {
  const owner = await enrol(db.app, business, 'owner');
  await db.admin.execute(
    "update public.memberships set role_key = 'owner' where business_id = $1 and person_id = $2",
    [business, owner.personId],
  );
  const grants = await db.app.withBusiness(business, async (tx) => ({
    conversation: await grantTo(tx, owner, 'write', undefined, false, 'conversation'),
    run: await grantTo(tx, owner, 'write', undefined, false, 'run'),
  }));
  const asked = { conversationId: randomUUID(), messageId: randomUUID() };
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(
      'insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title, model_id) values ($1, $2, $3, $4, $5, $6)',
      [business, asked.conversationId, owner.actorId, owner.personId, 'Plan', 'gpt-6.1-luna'],
    );
    await tx.query(
      "insert into public.conversation_messages (business_id, id, conversation_id, role, author_actor_id, body) values ($1, $2, $3, 'person', $4, 'Fix the About page')",
      [business, asked.messageId, asked.conversationId, owner.actorId],
    );
  });
  return { owner, grants, asked };
}

/** Sol's round 2 schedule: another connection holds the run grant, then revokes the conversation's. */
async function holdingRun(grants: { readonly run: string; readonly conversation: string }) {
  const lock = 'select 1 from public.grants where business_id = $1 and id = $2 for update';
  const revoke =
    'update public.grants set revoked_at = clock_timestamp() where business_id = $1 and id = $2';
  return await hold(
    db,
    async (execute) => {
      await execute(lock, [business, grants.run]);
    },
    async (execute) => {
      await execute(revoke, [business, grants.conversation]);
    },
  );
}

/**
 * A new owner's typed message on the plan, with `ended` revoked once the context transaction
 * returns; `waited`: revoked while the broker waits on the run grant (`holdingRun`).
 */
async function ask(ended: 'run' | 'conversation' | 'waited' | null) {
  const { owner, grants, asked } = await anOwner();
  let read = false;
  const database: Database = {
    ...db.app,
    withBusiness: async (id, work) => {
      const result = await db.app.withBusiness(id, work);
      const context = (result as { question?: { context?: unknown } } | undefined)?.question
        ?.context;
      if (!read && context !== undefined) {
        read = true;
        expect(JSON.stringify(context)).toContain(PAGE);
        const grant = ended === 'run' || ended === 'conversation' ? grants[ended] : undefined;
        if (grant !== undefined)
          await db.app.withBusiness(business, (tx) => revokeGrant(tx, grant));
      }
      return result;
    },
  };
  const sent: OutboundRequest[] = [];
  const exchange = conversationExchange({
    custody: recording(sent),
    operations: catalogue([OLLAMA_CONVERSATION, CHATGPT_PLAN_CONVERSATION]),
    providers: new Map([
      [OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }],
      [CHATGPT_PLAN_PROVIDER, PLAN_ADAPTER],
    ]),
    routes: [LOCAL, PLAN],
    installation: 'here',
  });
  const blocker = ended === 'waited' ? await holdingRun(grants) : undefined;
  const flight = exchange(database, business, owner.presented, asked);
  if (blocker !== undefined) {
    await waiterOf(db, blocker);
    await blocker.letGo();
  }
  const reply = await flight;
  expect(read).toBe(true);
  return { reply, sent };
}

describe.skipIf(serverUrl === undefined)('a plan call whose grant ended before the send', () => {
  it('goes out naming the bound page while every grant stands', async () => {
    const { reply, sent } = await ask(null);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain(PAGE);
    expect(reply?.answered).toBe(true);
  });

  it.each(['run', 'conversation', 'waited'] as const)(
    'sends nothing once the %s grant the context was read under ends',
    async (ended) => {
      const { reply, sent } = await ask(ended);
      expect(sent).toHaveLength(0);
      expect(reply?.answered).not.toBe(true);
    },
  );
});
