// SPDX-License-Identifier: AGPL-3.0-only
//
// Plants for the copy finder's agent cases (scripts/privacy/find-copies.mjs):
// people acting, agents, their delegations, credentials, sign-ins and grants,
// each in the business of the transaction it is given.

import { randomUUID } from 'node:crypto';
import type { Harness } from '../acceptance/role-case-harness.ts';

export type Query = Parameters<Parameters<Harness['world']['db']['app']['withBusiness']>[1]>[0];

/** The transaction's business, as row security reads it. */
const BUSINESS = 'public.app_business_id()';

/** A person with an acting identity. */
export async function plantActingPerson(
  tx: Query,
  name: string,
): Promise<{ person: string; actor: string }> {
  const person = randomUUID();
  const actor = randomUUID();
  await tx.query(
    `insert into public.people (business_id, id, display_name) values (${BUSINESS}, $1, $2)`,
    [person, name],
  );
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values (${BUSINESS}, $1, 'person', $2)`,
    [actor, person],
  );
  return { person, actor };
}

/** An agent acting for no person of its own; answers its id. */
export async function plantAgent(tx: Query): Promise<string> {
  const agent = randomUUID();
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values (${BUSINESS}, $1, 'agent', null)`,
    [agent],
  );
  return agent;
}

/** A delegation of `agent` acting for `person`, minted by `actor`; answers its id. */
export async function plantDelegation(
  tx: Query,
  agent: string,
  person: string,
  actor: string,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.delegations
       (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
        collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
     values (${BUSINESS}, $1, $2, $3, $4, $5, array['tasks'], array['read'], $6,
             now() + interval '1 day', 'record', $7)`,
    [id, agent, person, actor, `p${id.slice(0, 8)}`, 'd'.repeat(64), randomUUID()],
  );
  return id;
}

/** An agent of a credential `issuer` issued; answers the agent. */
export async function plantIssuedAgent(
  tx: Query,
  issuer: { person: string; actor: string },
): Promise<string> {
  const agent = await plantAgent(tx);
  await tx.query(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     values (${BUSINESS}, $1, $2, $3, $4, 'triage', array['tasks:read'], $5, 'hmac-sha256-v1', 'k1',
             now() + interval '1 day')`,
    [randomUUID(), agent, issuer.person, issuer.actor, '9'.repeat(64)],
  );
  return agent;
}

/** A grant to `subject`, given by `grantor`; answers its id. */
export async function plantGrant(tx: Query, subject: string, grantor: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.grants
       (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
     values (${BUSINESS}, $1, 'actor', $2, 'business', 'tasks', 'read', $3)`,
    [id, subject, grantor],
  );
  return id;
}

/** A sign-in of `agent`, linked by `linker`; answers the login and its link. */
export async function plantAgentLogin(
  tx: Query,
  agent: string,
  linker: string,
): Promise<{ login: string; link: string }> {
  const ids = { login: randomUUID(), link: randomUUID() };
  await tx.query(
    `insert into public.logins (business_id, id, provider, subject) values (${BUSINESS}, $1, 'dry-run', $2)`,
    [ids.login, `opaque-${randomUUID()}`],
  );
  await tx.query(
    `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
     values (${BUSINESS}, $1, $2, $3, $4)`,
    [ids.link, ids.login, agent, linker],
  );
  return ids;
}

/** The --id flags the finder printed for `person`. */
export function flagsFor(stderr: string, person: string): string[] {
  const line = stderr.split('\n').find((text) => text.includes(`search again for ${person} `));
  return (line?.split('add: ')[1] ?? '').split(' ').filter((part) => part !== '');
}
