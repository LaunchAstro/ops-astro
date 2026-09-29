// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a: the fixture's people, clients and agent. No command issues a root
// grant or a login, so these go in the way `scripts/local-seed.mjs` and the
// database suites put them; everything else the fixture holds is written
// through the commands (`generate.ts`).
/* eslint-disable no-await-in-loop -- `issueGrant` reads the granter's own rows */

import { randomUUID } from 'node:crypto';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { EmptyDatabase } from '../support/fresh-database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

export type Seedable = Pick<EmptyDatabase, 'app' | 'admin'>;

export interface Tenant {
  readonly id: BusinessId;
  readonly key: string;
  readonly members: readonly Member[];
  readonly lead: Member;
  /** Every person seeded here, clients included. */
  readonly people: string[];
}

export function refused(what: string, code: string): never {
  throw new Error(`fixture: ${what} refused ${code}`);
}

/**
 * The isolation roles, R1 to R6. R1 decides and shares; R4 holds nothing but
 * the one record-scoped grant SPEC 10.1 names (`grantOn`); R5 is a member
 * with no grant at all.
 */
export const ROLE_GRANTS: readonly (readonly Action[])[] = [
  ['read', 'write', 'assign', 'comment', 'decide', 'share', 'manage'],
  ['read', 'write', 'assign', 'comment'],
  ['read'],
  [],
  [],
  ['read', 'comment'],
];

/** A business with its task spine, settings, a spending cap and its people. */
export async function tenant(db: Seedable, key: string, people: number): Promise<Tenant> {
  const id = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, id);
  const members: Member[] = [];
  for (let n = 0; n < people; n += 1) {
    const name = `${key === 'alpha' ? 'R' : 'B'}${String(n + 1)}`;
    const member = await enrol(db.app, id, name);
    await db.app.withBusiness(id, async (tx) => {
      for (const action of ROLE_GRANTS[n] ?? []) {
        await grantTo(tx, member, action, undefined, true);
      }
    });
    members.push(member);
  }
  await db.app.withBusiness(id, async (tx) => {
    await installBusinessSettings(tx);
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', 1000000000, 'AUD')`,
      [id, randomUUID()],
    );
  });
  const lead = members[0] ?? refused('tenant', 'NO_PEOPLE');
  return { id, key, members, lead, people: members.map((m) => m.personId) };
}

/** One read grant on one task, and nothing else. */
export async function grantOn(
  db: Seedable,
  t: Tenant,
  who: Member,
  recordId: string,
): Promise<void> {
  await db.app.withBusiness(t.id, async (tx) => {
    await grantTo(tx, who, 'read', { kind: 'record', id: recordId });
  });
}

/** A client of this business, outside it, shown one task. */
export async function client(db: Seedable, t: Tenant, n: number, recordId: string): Promise<void> {
  const key = `${t.key}-client-${String(n)}`;
  await db.app.withBusiness(t.id, async (tx) => {
    const personId = await insertPerson(tx, key);
    await insertActor(tx, personId);
    const loginId = await insertLogin(tx, `${key}-${randomUUID()}`);
    await insertMapping(tx, loginId, personId, t.lead.actorId);
    const sharer = { personId: t.lead.personId, actorId: t.lead.actorId };
    const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
    if (!shared.ok) refused('share', shared.refusal.code);
    t.people.push(personId);
  });
}

/** The agent the runs are picked up by, linked by the business's lead. */
export async function agentOf(db: Seedable, t: Tenant): Promise<VerifiedSubject> {
  const subject = `fixture-agent-${randomUUID()}`;
  await db.app.withBusiness(t.id, async (tx) => {
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      t.id,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [t.id, randomUUID(), await insertLogin(tx, subject), actorId, t.lead.actorId],
    );
  });
  return { provider: 'supabase', subject };
}
