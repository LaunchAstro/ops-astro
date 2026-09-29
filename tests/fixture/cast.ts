// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a: the fixture's people, clients and agent. No command issues a root
// grant or a login, so these go in the way `scripts/local-seed.mjs` and the
// database suites put them; everything else the fixture holds is written
// through the commands (`generate.ts`).
/* eslint-disable no-await-in-loop -- `issueGrant` reads the granter's own rows */

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { EmptyDatabase } from '../support/fresh-database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { planPresetSync } from '../../packages/core-records/src/records/preset-plan.ts';
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

/**
 * Preset fields on the task type until it assigns `slots` slots (SPEC 10.1:
 * 24 of 38). No command applies a preset, so the slots come from the
 * product's own planner and the rows go in as the spine's do.
 */
export async function presetFields(db: Seedable, t: Tenant, slots: number): Promise<void> {
  await db.app.withBusiness(t.id, async (tx) => {
    const [held] = await tx.query<{ n: string; type: string }>(
      `select count(f.slot)::text n, t.id type from public.record_types t
         left join public.field_defs f on f.business_id = t.business_id
          and f.record_type_id = t.id and f.slot is not null
        where t.business_id = $1 and t.key = 'task' group by t.id`,
      [t.id],
    );
    const fields = Array.from({ length: slots - Number(held?.n) }, (_, n) => ({
      key: `fixture_${String(n + 1)}`,
      label: `Fixture ${String(n + 1)}`,
      valueType: n % 2 === 0 ? ('text' as const) : ('boolean' as const),
      writeMode: 'generic',
      visibilityClass: 'internal',
    }));
    const request = { recordTypeKey: 'task', presetKey: 'fixture', fields };
    const plan = await planPresetSync(tx, t.lead, request);
    if (!plan.ok) refused('preset plan', plan.refusal.code);
    for (const [n, step] of plan.value.actions.entries()) {
      const field = fields[n];
      if (step.action !== 'create_field' || field === undefined) refused('preset', step.action);
      await tx.query(
        `insert into public.field_defs (business_id, id, record_type_id, key, label, value_type,
           slot, write_mode, visibility_class, origin)
         values ($1, $2, $3, $4, $5, $6, $7, 'generic', 'internal', 'preset')`,
        [t.id, randomUUID(), held?.type, field.key, field.label, field.valueType, step.slot],
      );
    }
  });
}

/** A client of this business, outside it, shown one task. */
export async function client(
  db: Seedable,
  t: Tenant,
  n: number,
  recordId: string,
): Promise<VerifiedSubject> {
  const key = `${t.key}-client-${String(n)}`;
  const subject = `${key}-${randomUUID()}`;
  await db.app.withBusiness(t.id, async (tx) => {
    const personId = await insertPerson(tx, key);
    await insertActor(tx, personId);
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, t.lead.actorId);
    const sharer = { personId: t.lead.personId, actorId: t.lead.actorId };
    const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
    if (!shared.ok) refused('share', shared.refusal.code);
    t.people.push(personId);
  });
  return { provider: 'supabase', subject };
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

// The command entries the generator writes through (`generate.ts`): a refusal
// stops the seed with its code, and a task command goes at the record's
// current revision.

export type Detail = Readonly<Record<string, unknown>>;

export function applied(result: CommandResult, what: unknown): CommandHandle {
  return isCommandRefusal(result) ? refused(String(what), result.code) : result;
}

export async function command(db: Seedable, t: Tenant, body: Detail): Promise<CommandHandle> {
  const request = { operationId: randomUUID(), ...body };
  const result = await executeCommand(db.app, t.id, t.lead.presented, 'api', request as never);
  return applied(result, body['command']);
}

export async function create(
  db: Seedable,
  t: Tenant,
  title: string,
  place: Detail = {},
): Promise<string> {
  const made = await command(db, t, { command: 'task.create', fields: { title }, ...place });
  return made.recordId ?? refused('task.create', 'NO_RECORD');
}

export async function revisionOf(db: Seedable, recordId: string): Promise<number> {
  const [found] = await db.admin.execute<{ n: string }>(
    'select revision::text n from public.records where id = $1',
    [recordId],
  );
  return Number(found?.n);
}

/** A command on one task at its current revision. */
export async function onTask(
  db: Seedable,
  t: Tenant,
  recordId: string,
  body: Detail,
): Promise<CommandHandle> {
  return await command(db, t, {
    ...body,
    recordId,
    expectedRevision: await revisionOf(db, recordId),
  });
}

export async function refuseUnlessEmpty(db: Seedable): Promise<void> {
  const found = await db.admin.execute<{ n: string }>(
    `select case when to_regclass('public.businesses') is null then -1
                 else (select count(*) from public.businesses) end::text n`,
  );
  const n = Number(found[0]?.n);
  if (n < 0) throw new Error('fixture: DATABASE_NOT_MIGRATED, run the migrations first');
  if (n > 0) throw new Error(`fixture: DATABASE_NOT_EMPTY, ${String(n)} business(es) here`);
}
