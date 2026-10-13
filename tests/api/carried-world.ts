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
import { composeApi } from '../../apps/api/server.ts';
import {
  catalogue,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  carriedCustody,
  parseCarryKeys,
  type Carrier,
  type CarryKeys,
} from '../../packages/core-custody/src/index.ts';
import { conversationExchange } from '../../packages/core-commands/src/index.ts';
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

const SHIM = readFileSync(new URL('../support/realtime-shim.sql', import.meta.url), 'utf8');
const POLICY = readFileSync(
  new URL('../../migrations/20261013010300_carry_join_policy.sql', import.meta.url),
  'utf8',
);

export interface CarriedWorld {
  readonly w: ConversationWorld;
  readonly api: Hono;
  readonly database: Database;
  readonly hub: RealtimeHub;
  readonly ollama: StandIn;
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
 * lets more than one of the business's answers run at once.
 */
// oxlint-disable-next-line max-lines-per-function -- the world's parts, each made once
export async function carriedWorld(
  part: string,
  timeoutMs?: number,
  operation: { readonly maximumMinor?: number; readonly concurrency?: number } = {},
): Promise<CarriedWorld> {
  const fixture = await createApiFixture(part);
  await withRealtime(fixture.db.admin);
  const hub = await realtimeHub(adminUrlOf(fixture.db.name));
  const ollama = await standInOllama();
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
  const exchange = conversationExchange({
    custody,
    operations: catalogue([
      {
        ...OLLAMA_CONVERSATION,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...operation,
      },
    ]),
    providers: new Map([[OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }]]),
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
    ],
    installation: 'here',
    carrier,
  });
  const api: Hono = composeApi({
    keys: runtimeKeys({ ...fixture.environment }),
    database,
    admin: fixture.db.admin,
    signIn: testSignIn(ISSUER),
    executeRead,
    answerConversation: exchange,
    carrier,
  }).app;
  const w = await conversationWorld({ fixture, api });
  people.push(w.owner.personId);
  const agent = await carriageAgent({
    carriage: hubCarriage(hub),
    business: fixture.business,
    agent: fixture.agentActorId,
    token: await tokenFor(fixture.agent.subject),
    key,
    keys: parsed.keys,
    ollama: ollama.origin,
  });
  return {
    w,
    api,
    database,
    hub,
    ollama,
    agent,
    carrier,
    keys: parsed.keys,
    key,
    joined,
    beforeJoin,
    beforeSend,
    close: async () => {
      await agent.stop();
      await custody.stop();
      await hub.close();
      await ollama.close();
      await database.close();
      await w.drop();
    },
  };
}
