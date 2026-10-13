// SPDX-License-Identifier: AGPL-3.0-only
//
// A business set up for carriage: an owner and a colleague, each signed in
// through their own login; two agents, each with its own login; the owner's
// conversation with one message; and a carried call on that message given to
// the first agent, which is an open member of the conversation. Written
// through the application role inside the tenancy wrapper, as a deployment
// writes it, with made-up names only.

import { randomUUID } from 'node:crypto';
import type {
  AdminConnection,
  Database,
  TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';

export interface Party {
  readonly person: string;
  readonly actor: string;
  /** The provider subject its login carries: the JWT's `sub`. */
  readonly sub: string;
}

export interface Agent {
  readonly actor: string;
  readonly sub: string;
}

export interface Carried {
  readonly conversationId: string;
  readonly messageId: string;
  readonly callId: string;
}

export interface CarriageBusiness extends Carried {
  readonly id: string;
  readonly owner: Party;
  readonly colleague: Party;
  readonly agent: Agent;
  readonly otherAgent: Agent;
}

async function party(tx: TenantQuery, name: string, sub: string, linker?: string): Promise<Party> {
  const person = await insertPerson(tx, name);
  const actor = await insertActor(tx, person);
  await insertMembership(tx, person);
  await insertMapping(tx, await insertLogin(tx, sub), person, linker ?? actor);
  return { person, actor, sub };
}

async function agentOf(tx: TenantQuery, owner: Party, sub: string): Promise<Agent> {
  const actor = await insertAgentActor(tx);
  await tx.query(
    `update actors set display_name = 'M5 models', owner_person_id = $3
      where business_id = $1 and id = $2`,
    [tx.businessId, actor, owner.person],
  );
  await insertAgentMapping(tx, await insertLogin(tx, sub), actor, owner.actor);
  return { actor, sub };
}

/** A conversation of `owner`'s with one message, and none of its own calls. */
export async function conversationOf(
  tx: TenantQuery,
  owner: Party,
): Promise<{ readonly conversationId: string; readonly messageId: string }> {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await tx.query(
    `insert into conversations (business_id, id, owner_actor_id, owner_person_id, title)
     values ($1, $2, $3, $4, 'Due today')`,
    [tx.businessId, conversationId, owner.actor, owner.person],
  );
  await tx.query(
    `insert into conversation_messages (business_id, id, conversation_id, role, author_actor_id, body)
     values ($1, $2, $3, 'person', $4, 'What is due today?')`,
    [tx.businessId, messageId, conversationId, owner.actor],
  );
  return { conversationId, messageId };
}

/** A dispatched conversation call on the message, as the broker inserts one. */
export async function dispatchedCall(
  tx: TenantQuery,
  on: { readonly conversationId: string; readonly messageId: string | null },
): Promise<string> {
  const callId = randomUUID();
  await tx.query(
    `insert into model_calls
       (business_id, id, conversation_id, conversation_message_id, operation_key, state,
        reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref,
        started_at)
     values ($1, $2, $3, $4, 'conversation.answer', 'dispatched', 0, 'm5_ollama', 'local',
             'api_key', 'ollama', 'none', clock_timestamp())`,
    [tx.businessId, callId, on.conversationId, on.messageId],
  );
  return callId;
}

export async function openMembership(
  tx: TenantQuery,
  conversationId: string,
  agent: Agent,
  by: Party,
): Promise<void> {
  await tx.query(
    `insert into conversation_agent_members
       (business_id, conversation_id, agent_actor_id, added_by_actor_id)
     values ($1, $2, $3, $4)`,
    [tx.businessId, conversationId, agent.actor, by.actor],
  );
}

export async function carriersRow(tx: TenantQuery, callId: string, agent: Agent): Promise<void> {
  await tx.query(
    `insert into model_call_carriers (business_id, call_id, agent_actor_id) values ($1, $2, $3)`,
    [tx.businessId, callId, agent.actor],
  );
}

/** A conversation of `owner`'s, `agent` a member, and a call on its message carried by `agent`. */
export async function carriedCall(
  tx: TenantQuery,
  owner: Party,
  agent: Agent,
  member = true,
): Promise<Carried> {
  const conversation = await conversationOf(tx, owner);
  if (member) await openMembership(tx, conversation.conversationId, agent, owner);
  const callId = await dispatchedCall(tx, conversation);
  await carriersRow(tx, callId, agent);
  return { ...conversation, callId };
}

/**
 * The carriage business. `subs` names the provider subjects, so a case can
 * give one provider user a login in two businesses.
 */
export async function carriageBusiness(
  app: Database,
  key: string,
  subs: Partial<Record<'owner' | 'colleague' | 'agent' | 'otherAgent', string>> = {},
): Promise<CarriageBusiness> {
  const id = await insertBusiness(app, key);
  return await app.withBusiness(id, async (tx) => {
    const owner = await party(tx, 'Ada Example', subs.owner ?? randomUUID());
    const colleague = await party(tx, 'Ben Example', subs.colleague ?? randomUUID(), owner.actor);
    const agent = await agentOf(tx, owner, subs.agent ?? randomUUID());
    const otherAgent = await agentOf(tx, owner, subs.otherAgent ?? randomUUID());
    const carried = await carriedCall(tx, owner, agent);
    return { id, owner, colleague, agent, otherAgent, ...carried };
  });
}

/** The join function's answer for `topic`, with `sub` as the JWT's subject. */
export async function mayJoin(
  admin: AdminConnection,
  topic: string,
  claims: Record<string, unknown> | string | null,
): Promise<boolean> {
  return await admin.transaction(async (execute) => {
    if (claims !== null) {
      const text = typeof claims === 'string' ? claims : JSON.stringify(claims);
      await execute(`select set_config('request.jwt.claims', $1, true)`, [text]);
    }
    const [row] = await execute<{ readonly ok: boolean }>(
      'select public.ops_carry_may_join($1) as ok',
      [topic],
    );
    return row?.ok === true;
  });
}

export const callTopic = (business: string, callId: string): string =>
  `carry:${business}:call:${callId}`;
export const doorbellTopic = (business: string, agent: string): string =>
  `carry:${business}:agent:${agent}`;
