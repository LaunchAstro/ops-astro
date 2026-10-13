// SPDX-License-Identifier: AGPL-3.0-only
//
// When the carrier's agent joins a person's conversation, and when it leaves.
// It joins when a person the carrier lists starts a conversation, or picks a
// model, that it carries; a conversation on a client's task, or a person the
// carrier does not list, gets no member. Picking another carried model keeps
// the one membership; a model it does not carry closes it, and a purge does.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { OLLAMA_MODELS } from '../../packages/core-connectors/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { createApiFixture, ISSUER } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one carried world and its joins and leaves
describe.skipIf(serverUrl === undefined)('the agent joins only what the carrier may carry', () => {
  let w: ConversationWorld;
  let agent: string;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const fixture = await createApiFixture('agent_member_rules');
    agent = await fixture.db.app.withBusiness(fixture.business, (tx) => insertAgentActor(tx));
    // Only the owner is on the carrier's people list.
    const api: Hono = composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: fixture.db.app,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead,
      carrier: { agent, people: [fixture.member.personId] },
    }).app;
    w = await conversationWorld({ fixture, api });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'write');
      await grantTo(tx, w.owner, 'share');
    });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const open = async (conversationId: string) =>
    await w.count(
      `select count(*)::text as n from public.conversation_agent_members
        where conversation_id = $1 and agent_actor_id = $2 and left_at is null`,
      [conversationId, agent],
    );
  const all = async (conversationId: string) =>
    await w.count(
      `select count(*)::text as n from public.conversation_agent_members where conversation_id = $1`,
      [conversationId],
    );

  const started = async (member: typeof w.owner, body: Record<string, unknown>) => {
    const answer = await w.as(member, 'conversation.start', { body: 'What is due?', ...body });
    return String(detail(answer)['conversationId']);
  };

  it('a listed person joins it; an unlisted person does not', async () => {
    expect(await open(await started(w.owner, {}))).toBe(1);
    expect(await open(await started(w.owner, { model: OLLAMA_MODELS[1] }))).toBe(1);
    expect(await all(await started(w.colleague, {}))).toBe(0);
  });

  it("a conversation on a client's task gets no member; an internal task's does", async () => {
    const internal = await w.as(w.owner, 'task.create', { fields: { title: 'Internal' } });
    const internalId = String(internal.body['recordId']);
    expect(await open(await started(w.owner, { scope: { kind: 'task', id: internalId } }))).toBe(1);
    const clientId = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'For a client' } });
    const taskId = String(made.body['recordId']);
    const linked = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(linked.status).toBe(200);
    expect(await all(await started(w.owner, { scope: { kind: 'task', id: taskId } }))).toBe(0);
  });

  it('picking another carried model keeps one membership; a model it does not carry ends it', async () => {
    const conversationId = await started(w.owner, {});
    const pick = async (model: string | null) =>
      await w.as(w.owner, 'conversation.set_model', {
        operationId: randomUUID(),
        conversationId,
        model,
      });
    expect((await pick(OLLAMA_MODELS[1] ?? null)).status).toBe(200);
    expect((await pick(null)).status).toBe(200);
    expect(await all(conversationId)).toBe(1);
    expect(await open(conversationId)).toBe(1);
    // The install's provider moves off Ollama: its models are no longer the carrier's.
    vi.stubEnv('OPS_AGENT_PROVIDER', 'api');
    try {
      expect((await pick(null)).status).toBe(200);
    } finally {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    }
    expect(await open(conversationId)).toBe(0);
    // Picking a carried model again is a second membership, the first kept as it closed.
    expect((await pick(null)).status).toBe(200);
    expect(await open(conversationId)).toBe(1);
    expect(await all(conversationId)).toBe(2);
  });

  it("a purge closes the conversation's membership", async () => {
    const conversationId = await started(w.owner, {});
    expect(await open(conversationId)).toBe(1);
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await tx.query(
        `update conversations set body_purged_at = now(), purge_operation_id = $3
          where business_id = $1 and id = $2`,
        [w.fixture.business, conversationId, randomUUID()],
      );
    });
    expect(await open(conversationId)).toBe(0);
    expect(await all(conversationId)).toBe(1);
  });
});
