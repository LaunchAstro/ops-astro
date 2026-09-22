// SPDX-License-Identifier: AGPL-3.0-only
//
// Identity rows, written the way an installation would write them: through the
// application role, inside the tenancy wrapper, with every row carrying the
// business the transaction is set to. Nothing here uses the owner connection,
// so a fixture that only works as a superuser fails here rather than passing
// quietly and taking a test with it.

import { randomUUID } from 'node:crypto';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

export async function insertBusiness(database: Database, key: string): Promise<string> {
  const businessId = randomUUID();
  await database.withBusiness(businessId, async (tx) => {
    await tx.query('insert into businesses (business_id, id, key, name) values ($1, $1, $2, $3)', [
      businessId,
      key,
      key,
    ]);
  });
  return businessId;
}

export async function insertPerson(tx: TenantQuery, displayName: string): Promise<string> {
  const personId = randomUUID();
  await tx.query('insert into people (business_id, id, display_name) values ($1, $2, $3)', [
    tx.businessId,
    personId,
    displayName,
  ]);
  return personId;
}

export async function insertActor(
  tx: TenantQuery,
  personId: string,
  active = true,
): Promise<string> {
  const actorId = randomUUID();
  await tx.query(
    `insert into actors (business_id, id, kind, person_id, active, deactivated_at)
     values ($1, $2, 'person', $3, $4, $5)`,
    [tx.businessId, actorId, personId, active, active ? null : new Date()],
  );
  return actorId;
}

export async function insertMembership(
  tx: TenantQuery,
  personId: string,
  active = true,
): Promise<string> {
  const membershipId = randomUUID();
  await tx.query(
    `insert into memberships (business_id, id, person_id, role_key, active, ended_at)
     values ($1, $2, $3, 'member', $4, $5)`,
    [tx.businessId, membershipId, personId, active, active ? null : new Date()],
  );
  return membershipId;
}

export async function insertLogin(tx: TenantQuery, subject: string): Promise<string> {
  const loginId = randomUUID();
  await tx.query(
    `insert into logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)`,
    [tx.businessId, loginId, subject],
  );
  return loginId;
}

export async function insertMapping(
  tx: TenantQuery,
  loginId: string,
  personId: string,
  linkedByActorId: string,
  active = true,
): Promise<string> {
  const mappingId = randomUUID();
  await tx.query(
    `insert into person_logins
       (business_id, id, login_id, person_id, active, linked_by_actor_id, deactivated_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tx.businessId,
      mappingId,
      loginId,
      personId,
      active,
      linkedByActorId,
      active ? null : new Date(),
    ],
  );
  return mappingId;
}

export async function insertIdentifier(
  tx: TenantQuery,
  personId: string,
  value: string,
  sourceSystem = 'fixture',
): Promise<string> {
  const identifierId = randomUUID();
  await tx.query(
    `insert into person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system)
     values ($1, $2, $3, 'email', $4, $4, $5)`,
    [tx.businessId, identifierId, personId, value, sourceSystem],
  );
  return identifierId;
}

export async function insertMerge(
  tx: TenantQuery,
  survivingPersonId: string,
  absorbedPersonId: string,
  decidedByActorId: string,
): Promise<string> {
  const mergeId = randomUUID();
  await tx.query(
    `insert into person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     values ($1, $2, $3, $4, $5, 'a person decided, in the fixture')`,
    [tx.businessId, mergeId, survivingPersonId, absorbedPersonId, decidedByActorId],
  );
  return mergeId;
}

export async function countRows(tx: TenantQuery, table: string): Promise<number> {
  if (!/^[a-z_]+$/u.test(table)) throw new Error(`countRows: unsafe table ${table}`);
  const rows = await tx.query<{ readonly count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(rows[0]?.count ?? '-1');
}
