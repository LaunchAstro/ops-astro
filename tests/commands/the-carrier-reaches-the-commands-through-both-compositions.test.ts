// SPDX-License-Identifier: AGPL-3.0-only
//
// The deployment's carrier setting (`MODEL_BROKER_CARRIER`) reaches the
// conversation commands through both composition roots: the server's
// `composeApi` handed the parsed setting, and the Vercel function reading it
// from its own settings. With it, a listed person's `conversation.start` on a
// model the carrier carries adds the carrier's agent as a member; without it,
// nothing is written. The function refuses to start on a setting it cannot
// carry: malformed, another provider, or beside a custody setting.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { serveTestKeySet, testSignIn, type ServedKeySet } from '../support/sign-in.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import { conversationWorld, detail, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { personPath } from '../api/controls-fixture.ts';
import { authorised, createApiFixture, ISSUER, post, tokenFor } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A `conversation.start` through `call`, and the conversation it made. */
async function start(call: (body: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  const answer = await call({ operationId: randomUUID(), body: 'What is due today?' });
  return String(detail(answer as Parameters<typeof detail>[0])['conversationId']);
}

const HOST = 'ops.example.test';
const KEY_ID = 'test/carrier@1';
const KEYRING = {
  DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
  DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
};
const OLLAMA_ROUTE = JSON.stringify([
  {
    key: 'm5_ollama',
    reach: 'local',
    provider: 'ollama',
    credentialRef: 'ollama_none',
    credentialKind: 'api_key',
    installation: 'here',
    ceiling: 1,
  },
]);

/** The function's settings for a carried deployment, the carrier left to the case. */
const carried = (carrier: string | undefined): Record<string, string | undefined> => ({
  ...KEYRING,
  DATABASE_URL: 'postgres://app:carrier@127.0.0.1:1/none',
  GOTRUE_URL: ISSUER,
  SERVED_HOST: HOST,
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_ROUTES: OLLAMA_ROUTE,
  MODEL_BROKER_INSTALLATION: 'here',
  MODEL_BROKER_CARRIER: carrier,
});

describe('the function refuses a carrier setting it cannot carry', () => {
  const agent = randomUUID();
  const person = randomUUID();
  const good = JSON.stringify({ agent, people: [person] });

  it('starts with a well-formed carrier on an Ollama route', () => {
    expect(() => createFunctionHandler(carried(good))).not.toThrow();
  });

  it.each([
    ['not JSON', 'carrier-setting-not-json'],
    ['an extra key', JSON.stringify({ agent, people: [person], key: 'x' })],
    ['no people', JSON.stringify({ agent, people: [] })],
    ['an id that is not one', JSON.stringify({ agent: 'm5', people: [person] })],
    ['an id in capitals', JSON.stringify({ agent: agent.toUpperCase(), people: [person] })],
    ['a person twice', JSON.stringify({ agent, people: [person, person] })],
  ])('refuses %s, never echoing the setting', (_name, setting) => {
    expect(() => createFunctionHandler(carried(setting))).toThrow(/MODEL_BROKER_CARRIER/u);
    try {
      createFunctionHandler(carried(setting));
    } catch (cause) {
      expect((cause as Error).message).not.toContain(setting);
    }
  });

  it.each([
    ['another provider', { OPS_AGENT_PROVIDER: 'api' }],
    ['a credentials file', { MODEL_BROKER_CREDENTIALS_FILE: '/tmp/credentials.json' }],
    ['a destination', { MODEL_BROKER_DESTINATIONS: '[]' }],
    ['no Ollama local route', { MODEL_BROKER_ROUTES: '[]' }],
  ])('refuses a carrier beside %s', (_name, extra) => {
    expect(() => createFunctionHandler({ ...carried(good), ...extra })).toThrow(
      /MODEL_BROKER_CARRIER/u,
    );
  });
});

// eslint-disable-next-line max-lines-per-function -- one world, two composition roots
describe.skipIf(serverUrl === undefined)('the carrier into conversation.start', () => {
  let w: ConversationWorld;
  let keySet: ServedKeySet;
  let agent: string;
  let lookup: { url: string; name: string } | undefined;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const fixture = await createApiFixture('carrier_commands');
    w = await conversationWorld({ fixture, api: fixture.compose() });
    agent = await fixture.db.app.withBusiness(fixture.business, (tx) => insertAgentActor(tx));
    keySet = await serveTestKeySet();
    lookup = await loginIn(fixture.db, 'ops_astro_lookup', 'carrier');
  }, 120_000);

  afterAll(async () => {
    await keySet?.close();
    await w?.drop();
    vi.unstubAllEnvs();
    if (lookup === undefined) return;
    const cleanup = new Client(serverUrl ?? '');
    await cleanup.query(`drop role if exists "${lookup.name}"`).finally(() => cleanup.end());
  });

  const members = async (conversationId: string) =>
    await w.fixture.db.admin.execute<{ agent_actor_id: string; added_by_actor_id: string }>(
      `select agent_actor_id::text, added_by_actor_id::text
         from public.conversation_agent_members where conversation_id = $1 and left_at is null`,
      [conversationId],
    );

  it("through the server's composition: a member with the carrier, none without", async () => {
    const { fixture } = w;
    const withCarrier = composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: fixture.db.app,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead,
      carrier: { agent, people: [w.owner.personId] },
    }).app;
    const token = await tokenFor(w.owner.presented.subject);
    const on = (api: typeof withCarrier) => async (body: Record<string, unknown>) =>
      await post(api, personPath('conversation.start'), body, authorised(token));
    const carriedOne = await start(on(withCarrier));
    expect(await members(carriedOne)).toEqual([
      { agent_actor_id: agent, added_by_actor_id: w.owner.actorId },
    ]);
    const plainOne = await start(on(fixture.compose()));
    expect(await members(plainOne)).toEqual([]);
  });

  it("through the function's composition: a member with the setting, none without", async () => {
    const { fixture } = w;
    const token = await tokenFor(w.owner.presented.subject);
    const handlerWith = (carrier?: string) =>
      createFunctionHandler({
        ...fixture.environment,
        ...carried(carrier),
        DATABASE_URL: fixture.db.appUrl,
        DATABASE_LOOKUP_URL: lookup?.url,
        SUPABASE_KEY_SET_URL: keySet.url,
      });
    const through =
      (handle: (request: Request) => Promise<Response>) =>
      async (body: Record<string, unknown>) => {
        const response = await handle(
          new Request(`https://${HOST}${personPath('conversation.start')}`, {
            method: 'POST',
            headers: { host: HOST, 'content-type': 'application/json', ...authorised(token) },
            body: JSON.stringify(body),
          }),
        );
        return { status: response.status, body: (await response.json()) as unknown };
      };
    const setting = JSON.stringify({ agent, people: [w.owner.personId] });
    const carriedOne = await start(through(handlerWith(setting)));
    expect(await members(carriedOne)).toEqual([
      { agent_actor_id: agent, added_by_actor_id: w.owner.actorId },
    ]);
    const plainOne = await start(through(handlerWith()));
    expect(await members(plainOne)).toEqual([]);
  });
});
