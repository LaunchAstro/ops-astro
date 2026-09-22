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

export const TASK_COLLECTION = 'task';
export const WHOLE_BUSINESS: Scope = { kind: 'business', id: null };

export interface Member {
  readonly personId: string;
  readonly actorId: string;
  readonly presented: VerifiedSubject;
}

/** A person who can sign in. No grants: those are the caller's to issue. */
export async function enrol(database: Database, businessId: string, name: string): Promise<Member> {
  return await database.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const subject = `${name}-${randomUUID()}`;
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    return { personId, actorId, presented: { provider: 'supabase', subject } };
  });
}

/** A root grant, which only an administrative path issues. */
export async function grantTo(
  tx: TenantQuery,
  member: Member,
  action: Action,
  scope: Scope = WHOLE_BUSINESS,
  canDelegate = false,
): Promise<string> {
  const issued = await issueGrant(tx, [], {
    subject: { kind: 'person', id: member.personId },
    scope,
    collection: TASK_COLLECTION,
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
