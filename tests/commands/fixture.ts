// SPDX-License-Identifier: AGPL-3.0-only
//
// A business with a person who can sign in and a grant that lets them work.
//
// Commands run through `withSession`, so a test needs the whole identity
// chain — a login, a mapping, a membership and an actor — rather than an actor
// identifier on its own. Everything is written through the application role
// inside the tenancy wrapper, like the fixtures the earlier parts wrote.

import { randomUUID } from 'node:crypto';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  installTaskSpine,
  type InstalledTaskSpine,
} from '../../packages/core-records/src/tasks/install.ts';
import {
  issueGrant,
  type Action,
  type Scope,
} from '../../packages/core-records/src/authority/grants.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';

export const TASK_COLLECTION = 'task';
export const WHOLE_BUSINESS: Scope = { kind: 'business', id: null };

export interface Member {
  readonly personId: string;
  readonly actorId: string;
  readonly presented: VerifiedSubject;
}

/**
 * A person who can sign in. No grants: those are the caller's to issue. They
 * signed in with the second factor as they were enrolled, so a money act of
 * theirs is inside C59's step-up window; a case about the step-up itself
 * presents the assurance it means instead.
 */
export async function enrol(database: Database, businessId: string, name: string): Promise<Member> {
  return await database.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const subject = `${name}-${randomUUID()}`;
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    return { personId, actorId, presented: freshSubject(subject) };
  });
}

/** `subject` signed in just now with the second factor: inside C59's step-up window. */
export function freshSubject(subject: string): VerifiedSubject {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'supabase',
    subject,
    assurance: { level: 'aal2', signedInAt: now, factorAt: now },
  };
}

/** A root grant, which only an administrative path issues. */
export async function grantTo(
  tx: TenantQuery,
  member: Member,
  action: Action,
  scope: Scope = WHOLE_BUSINESS,
  canDelegate = false,
  /**
   * The collection, which is no longer always `task`: `preset.plan` asks about
   * presets and the settings commands about settings, and a fixture that could
   * only grant on tasks would have made those three untestable — or, worse,
   * would have hidden a grant check that was still reading the wrong
   * collection.
   */
  collection: string = TASK_COLLECTION,
): Promise<string> {
  const issued = await issueGrant(tx, [], {
    subject: { kind: 'person', id: member.personId },
    scope,
    collection,
    action,
    canDelegate,
    parentGrantId: null,
    grantedByActorId: member.actorId,
  });
  if (!issued.ok) throw new Error(`grantTo: refused ${issued.refusal.code}`);
  return issued.value;
}

export async function installSpine(
  database: Database,
  businessId: string,
): Promise<InstalledTaskSpine> {
  return await database.withBusiness(businessId, async (tx) => await installTaskSpine(tx));
}

/**
 * A client outside the business: a login and a person with no membership, who
 * stands on the one task `member` shares with them (the external view).
 */
export async function shareWithClient(
  database: Database,
  businessId: string,
  member: Member,
  recordId: string,
): Promise<Member> {
  const subject = `client-${randomUUID()}`;
  return await database.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, member.actorId);
    const sharer = { personId: member.personId, actorId: member.actorId };
    const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
    if (!shared.ok) throw new Error(`shareWithClient: refused ${shared.refusal.code}`);
    return { personId, actorId, presented: { provider: 'supabase', subject } };
  });
}

/**
 * A client of this business under a chosen id (C32): `task.set_party` and a
 * party-scoped grant name only a client the business holds, so a world that
 * puts tasks on clients makes them as rows first, through the application role.
 */
export async function addClient(
  database: Database,
  businessId: string,
  clientId: string,
  by: Member,
): Promise<void> {
  await database.withBusiness(businessId, async (tx) => {
    await tx.query(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, $2, $3, $4)`,
      [tx.businessId, clientId, `client ${clientId}`, by.actorId],
    );
  });
}
