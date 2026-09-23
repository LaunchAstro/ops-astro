// SPDX-License-Identifier: AGPL-3.0-only
//
// I07 in the schema: a delegation never carries `decide`, and a gate decision
// always names a person.
//
// The code refuses a delegated decision before it reaches a table
// (`authority/delegations.ts`, `DELEGATION_EXCLUDES_DECISION`). These cases
// hold the two barriers behind it, written directly as the application role
// so no code path stands in front of them: `delegations_never_decide`
// (0008_agent_authority.sql:186) on insert and on update, and
// `gate_decisions.decided_by_person_id not null` (0012_runtime_decisions.sql:36).
// A valid delegation written the same way is the control, so the refusals are
// about `decide` and the missing person, not about the shape of the row.
//
// `delegations_actions_known` (0008:188) also leaves `decide` out, and sorts
// first, so it is the constraint an ordinary write reports. The third case
// lifts it inside a transaction that ends in the refusal, which is the only
// way to show `delegations_never_decide` holding on its own.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { sqlRefusal } from '../runtime/gate-negatives-cases.ts';

const serverUrl = databaseUrlFromEnvironment();
const HEX64 = 'a'.repeat(64);

describe.skipIf(serverUrl === undefined)('a decision is never delegated, in the schema', () => {
  let db: FreshDatabase;
  let business: string;
  let person: string;
  let personActor: string;
  let agentActor: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'g3nd' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      person = await insertPerson(tx, 'Ada');
      personActor = await insertActor(tx, person);
      await insertMembership(tx, person);
      agentActor = await insertAgentActor(tx);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** One delegation row, written as the application role with nothing in front of it. */
  const insertDelegation = async (
    tx: TenantQuery,
    purpose: string,
    actions: readonly string[],
  ): Promise<string> => {
    const id = randomUUID();
    await tx.query(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
       values ($1, $2, $3, $4, $5, $6, array['task'], $7::text[], $8,
               now() + interval '1 hour', 'record', $9)`,
      [
        tx.businessId,
        id,
        agentActor,
        person,
        personActor,
        purpose,
        [...actions],
        HEX64,
        randomUUID(),
      ],
    );
    return id;
  };

  const delegationsFor = async (purpose: string): Promise<number> => {
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.delegations where business_id = $1 and purpose = $2`,
      [business, purpose],
    );
    return Number(rows[0]?.n ?? 0);
  };

  it('writes a delegation that does not decide: the control', async () => {
    const id = await db.app.withBusiness(
      business,
      async (tx) => await insertDelegation(tx, 'control_read_write', ['read', 'write']),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await delegationsFor('control_read_write')).toBe(1);
  });

  it('refuses decide written as the application role, by insert and by update', async () => {
    // Two checks refuse `decide` here: `delegations_never_decide` and
    // `delegations_actions_known`, whose list leaves `decide` out. Postgres
    // evaluates check constraints in name order, so the one it reports is
    // `delegations_actions_known`. The next case holds `never_decide` alone.
    const inserted = await sqlRefusal(
      db.app.withBusiness(
        business,
        async (tx) => await insertDelegation(tx, 'insert_decide', ['read', 'decide']),
      ),
    );
    expect(inserted).toStrictEqual({
      code: '23514',
      constraint: 'delegations_actions_known',
      column: null,
    });
    expect(await delegationsFor('insert_decide')).toBe(0);

    const id = await db.app.withBusiness(
      business,
      async (tx) => await insertDelegation(tx, 'update_decide', ['read']),
    );
    const updated = await sqlRefusal(
      db.app.withBusiness(business, async (tx) => {
        await tx.query(
          `update public.delegations set actions = array_append(actions, 'decide')
            where business_id = $1 and id = $2`,
          [tx.businessId, id],
        );
      }),
    );
    expect(updated).toStrictEqual({
      code: '23514',
      constraint: 'delegations_actions_known',
      column: null,
    });
    const rows = await db.admin.execute<{ readonly actions: readonly string[] }>(
      `select actions from public.delegations where id = $1`,
      [id],
    );
    expect(rows.map((row) => row.actions)).toStrictEqual([['read']]);
  });

  it('refuses decide on delegations_never_decide alone, by insert and by update', async () => {
    // The owner lifts `delegations_actions_known` inside one transaction, the
    // statements run as the application role, and the transaction ends in the
    // refusal, so the lifted check comes back with it.
    const alone = async (statement: string, parameters: readonly unknown[]) =>
      await sqlRefusal(
        db.admin.transaction(async (execute) => {
          await execute(`alter table public.delegations drop constraint delegations_actions_known`);
          await execute(`set local role ops_astro_app`);
          await execute(`select set_config('app.business_id', $1, true)`, [business]);
          await execute(statement, parameters);
        }),
      );

    const inserted = await alone(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
       values ($1, $2, $3, $4, $5, 'alone_decide', array['task'], array['read', 'decide'], $6,
               now() + interval '1 hour', 'record', $7)`,
      [business, randomUUID(), agentActor, person, personActor, HEX64, randomUUID()],
    );
    expect(inserted).toStrictEqual({
      code: '23514',
      constraint: 'delegations_never_decide',
      column: null,
    });
    expect(await delegationsFor('alone_decide')).toBe(0);

    const id = await db.app.withBusiness(
      business,
      async (tx) => await insertDelegation(tx, 'alone_update', ['read']),
    );
    const updated = await alone(
      `update public.delegations set actions = array_append(actions, 'decide')
        where business_id = $1 and id = $2`,
      [business, id],
    );
    expect(updated).toStrictEqual({
      code: '23514',
      constraint: 'delegations_never_decide',
      column: null,
    });

    const checks = await db.admin.execute<{ readonly conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'public.delegations'::regclass
          and conname in ('delegations_actions_known', 'delegations_never_decide')
        order by conname`,
    );
    expect(checks.map((row) => row.conname)).toStrictEqual([
      'delegations_actions_known',
      'delegations_never_decide',
    ]);
    const rows = await db.admin.execute<{ readonly actions: readonly string[] }>(
      `select actions from public.delegations where id = $1`,
      [id],
    );
    expect(rows.map((row) => row.actions)).toStrictEqual([['read']]);
  });

  it('refuses a gate decision with no deciding person, on the column and before any key', async () => {
    const decision = async (tx: TenantQuery, decidedBy: string | null): Promise<void> => {
      await tx.query(
        `insert into public.gate_decisions
           (business_id, id, gate_id, version_id, lineage_id, seq, decision, round,
            decided_by_person_id, decided_by_actor_id, payload, payload_digest,
            evidence_digest, signing_key_id, signature, prev_hash, hash)
         values ($1, $2, $3, $4, $5, 1, 'approve', 1, $6, $7, '{}'::jsonb, $8, $8, 'k', 's', $8, $8)`,
        [
          tx.businessId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          decidedBy,
          agentActor,
          HEX64,
        ],
      );
    };

    const missing = await sqlRefusal(
      db.app.withBusiness(business, async (tx) => await decision(tx, null)),
    );
    expect(missing).toStrictEqual({
      code: '23502',
      constraint: null,
      column: 'decided_by_person_id',
    });

    // The same row with a person named gets past the column and stops at the
    // gate it names, which does not exist. So the refusal above was the
    // missing person, and the application role can reach the table at all.
    const named = await sqlRefusal(
      db.app.withBusiness(business, async (tx) => await decision(tx, person)),
    );
    expect(named.code).toBe('23503');
    expect(named.constraint).toBe('gate_decisions_gate_fkey');

    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.gate_decisions where business_id = $1`,
      [business],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});
