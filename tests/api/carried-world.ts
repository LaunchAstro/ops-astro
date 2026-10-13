// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for the carried calls: the real API composed on a pool of its own,
// its broker carried (`Broker.carrier`) over the carried custody, the
// Realtime shim and hub on the world's database, the agent stand-in on the
// agent's own login, and the stand-in Ollama it sends to. The person sends
// as the side panel sends, with their own token, which the function uses to
// join the call's line.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { vi } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import {
  catalogue,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_CONVERSATION,
  OPENROUTER_PROVIDER,
  openrouterCostMinor,
  openrouterRequest,
} from '../../packages/core-connectors/src/index.ts';
import {
  carriedCustody,
  parseCarryKeys,
  type Carrier,
  type CarryKeys,
} from '../../packages/core-custody/src/index.ts';
import {
  conversationExchange,
  type ConversationExchange,
  type ModelBroker,
} from '../../packages/core-commands/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { carriageAgent, type AgentStandIn } from '../support/carriage-agent.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import { realtimeHub, type RealtimeHub } from '../support/realtime-hub.ts';
import { testSignIn } from '../support/sign-in.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { createApiFixture, ISSUER, tokenFor } from './fixture.ts';
import { standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';
import { standInOpenRouter, type OpenRouterStandIn } from './openrouter-stand-in-fixture.ts';

const SHIM = readFileSync(new URL('../support/realtime-shim.sql', import.meta.url), 'utf8');
const POLICY = readFileSync(
  new URL('../../migrations/20261013010300_carry_join_policy.sql', import.meta.url),
  'utf8',
);

/** A paid reply's most in a carried world, in AUD cents. */
export const PAID_HOLD = 25;

export interface CarriedWorld {
  readonly w: ConversationWorld;
  readonly api: Hono;
  readonly database: Database;
  readonly hub: RealtimeHub;
  readonly ollama: StandIn;
  /** The stand-in OpenRouter, in a world with the outside provider on. */
  readonly openrouter: OpenRouterStandIn | undefined;
  /** The broker's outside people list, as its settings hold it: a case may reload it. */
  readonly outsidePeople: string[];
  readonly agent: AgentStandIn;
  readonly carrier: Carrier;
  readonly keys: CarryKeys;
  readonly key: string;
  /** Topics the function's custody joined. */
  readonly joined: string[];
  /** Runs as the function joins a call's line: after the command commits, before the offer. */
  readonly beforeJoin: { run: (topic: string) => Promise<void> };
  /** Runs before the function sends each message on a call's line. */
  readonly beforeSend: { run: (event: string) => Promise<void> };
  /**
   * A second instance of the function: the same broker settings over a pool,
   * custody and API of its own, as another server would run them.
   */
  twin(): Promise<CarriedTwin>;
  close(): Promise<void>;
}

/** Another instance of the carried function, on its own connections. */
export interface CarriedTwin {
  readonly api: Hono;
  readonly exchange: ConversationExchange;
  readonly database: Database;
  close(): Promise<void>;
}

/** The database's owner URL, for the hub's own connections. */
function adminUrlOf(name: string): string {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('no database server');
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The shim, then the join policy's guarded half, which a migration ran before Realtime was here. */
async function withRealtime(admin: ConversationWorld['fixture']['db']['admin']): Promise<void> {
  await admin.transaction(async (execute) => {
    await execute(SHIM);
    await execute(POLICY.slice(POLICY.indexOf('do $$')));
  });
}

/**
 * `timeoutMs`, where given, shortens Ollama's wait, and so each call's
 * `answer_by`; `operation`, where given, prices the conversation operation or
 * lets more than one of the business's answers run at once. `outside` turns on
 * OpenRouter's paid chat, held at PAID_HOLD, for the owner, on one cloud API
 * key route the model agent carries.
 */
// oxlint-disable-next-line max-lines-per-function -- the world's parts, each made once
export async function carriedWorld(
  part: string,
  timeoutMs?: number,
  operation: { readonly maximumMinor?: number; readonly concurrency?: number } = {},
  outside = false,
): Promise<CarriedWorld> {
  const fixture = await createApiFixture(part);
  await withRealtime(fixture.db.admin);
  const hub = await realtimeHub(adminUrlOf(fixture.db.name));
  const ollama = await standInOllama();
  const openrouter = outside ? await standInOpenRouter() : undefined;
  const outsidePeople: string[] = [];
  const key = randomBytes(32).toString('base64url');
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('carry key refused');
  const joined: string[] = [];
  const beforeJoin = { run: async (_topic: string): Promise<void> => {} };
  const beforeSend = { run: async (_event: string): Promise<void> => {} };
  const custody = carriedCustody({
    carriage: hubCarriage(hub, joined, beforeJoin, beforeSend),
    keys: parsed.keys,
    key,
  });
  const database = connect(fixture.db.appUrl, { source: 'runtime' });
  // The people the carrier carries for: the owner, once the world has enrolled them.
  const people: string[] = [];
  const carrier: Carrier = { agent: fixture.agentActorId, people };
  const settings: Omit<ModelBroker, 'custody'> = {
    operations: catalogue([
      {
        ...OLLAMA_CONVERSATION,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...operation,
      },
      ...(outside ? [{ ...OPENROUTER_CONVERSATION, maximumMinor: PAID_HOLD }] : []),
    ]),
    providers: new Map([
      [OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }],
      [
        OPENROUTER_PROVIDER,
        { build: openrouterRequest, price: openrouterCostMinor, bodyLimit: OPENROUTER_BODY_LIMIT },
      ],
    ]),
    routes: [
      {
        key: 'm5_ollama',
        reach: 'local',
        provider: OLLAMA_PROVIDER,
        credentialRef: 'carried',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
      ...(outside
        ? [
            {
              key: 'openrouter',
              reach: 'cloud' as const,
              provider: OPENROUTER_PROVIDER,
              credentialRef: 'openrouter',
              credentialKind: 'api_key' as const,
              installation: 'here',
              ceiling: 1,
            },
          ]
        : []),
    ],
    installation: 'here',
    carrier,
    outsidePeople,
  };
  const exchange = conversationExchange({ custody, ...settings });
  const apiOver = (pool: Database, answering: ConversationExchange): Hono =>
    composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: pool,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead,
      answerConversation: answering,
      carrier,
    }).app;
  const api: Hono = apiOver(database, exchange);
  const w = await conversationWorld({ fixture, api });
  people.push(w.owner.personId);
  if (outside) {
    outsidePeople.push(`${fixture.business}:${w.owner.personId}`);
    // The panel offers the paid model to the people the install lists, as the API's settings say.
    vi.stubEnv('OPS_OUTSIDE_PROVIDER', 'openrouter');
    vi.stubEnv('OPS_OUTSIDE_MODEL_PEOPLE', outsidePeople.join(','));
  }
  const agent = await carriageAgent({
    carriage: hubCarriage(hub),
    business: fixture.business,
    agent: fixture.agentActorId,
    token: await tokenFor(fixture.agent.subject),
    key,
    keys: parsed.keys,
    ollama: ollama.origin,
    ...(openrouter === undefined ? {} : { openrouter: openrouter.origin }),
  });
  return {
    w,
    api,
    database,
    hub,
    ollama,
    openrouter,
    outsidePeople,
    agent,
    carrier,
    keys: parsed.keys,
    key,
    joined,
    beforeJoin,
    beforeSend,
    twin: async () => {
      const own = carriedCustody({ carriage: hubCarriage(hub), keys: parsed.keys, key });
      const pool = connect(fixture.db.appUrl, { source: 'runtime' });
      const answering = conversationExchange({ custody: own, ...settings });
      return await Promise.resolve({
        api: apiOver(pool, answering),
        exchange: answering,
        database: pool,
        close: async () => {
          await own.stop();
          await pool.close();
        },
      });
    },
    close: async () => {
      await agent.stop();
      await custody.stop();
      await hub.close();
      await ollama.close();
      await openrouter?.close();
      await database.close();
      await w.drop();
    },
  };
}
