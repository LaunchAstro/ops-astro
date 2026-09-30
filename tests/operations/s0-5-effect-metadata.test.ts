// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved rather than trusted: every command in the
// catalogue is run once on its positive fixture (the role-case harness's
// recipes), and the tables whose rows changed are compared with the record
// kinds it declares. An undeclared write fails; so does a kind declared
// business-internal whose table reaches a task or a client through its
// foreign keys, since a row holding a task's id is a client-scoped write.
// The act's own bookkeeping (its audit event, its operation row, the bearer's
// verification and the live change record) is the same for every call and is
// not a record kind.
// A declared kind that is no table fails too, so a misspelt one cannot pass. Two commands have no
// recipe of their own (a grant id, a live delegation) and get one here.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandDeclaration,
} from '../../packages/core-wire/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import type { Prepared } from '../acceptance/role-case-bodies.ts';
import { serverUrl } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-effect-metadata: DATABASE_URL is unset, so nothing below ran.');
}

/**
 * Written for every call as the record of the act, never a record kind of its
 * own: the audit event, the operation row, the bearer's verification, and the
 * live change record (0051, C4), stamped by a task write's own triggers with
 * only which task and the writing transaction.
 */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
  'live_changes',
]);

let harness: Harness;

/** Each public table's rows as one digest, read past row security on the owner's connection. */
async function fingerprint(): Promise<ReadonlyMap<string, string>> {
  const tables = await harness.world.db.admin.execute<{ readonly name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const union = tables
    .map(
      ({ name }) =>
        `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${name} t`,
    )
    .join(' union all ');
  const rows = await harness.world.db.admin.execute<{ name: string; digest: string }>(union);
  return new Map(rows.map((row) => [row.name, row.digest]));
}

/** Tables that reach `records` (tasks) or `clients` through their foreign keys. */
async function clientScoped(): Promise<ReadonlySet<string>> {
  const rows = await harness.world.db.admin.execute<{ readonly name: string }>(
    `with recursive fk as (
       select distinct c.relname as t, r.relname as ref
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_class r on r.oid = k.confrelid
         join pg_namespace n on n.oid = c.relnamespace
        where k.contype = 'f' and n.nspname = 'public' and c.relname <> r.relname
     ), reach(t) as (
       select 'records'::name union select 'clients'::name
       union select fk.t from fk join reach on fk.ref = reach.t
     )
     select t::text as name from reach`,
  );
  return new Set(rows.map((row) => row.name));
}

/** The positive recipe, or one made here where it changes nothing or there is none. */
async function bodyFor(declaration: CommandDeclaration): Promise<Prepared> {
  if (declaration.name === 'grant.revoke') {
    const mia = harness.world.mia as unknown as Member;
    const grantId = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) => await grantTo(tx, mia, 'comment'),
    );
    return { body: { grantId } };
  }
  if (declaration.name === 'access.grant') {
    // The recipe re-grants a key the member already holds; one client's is new.
    const made = await harness.asPerson('client.create', { name: `s0-5 effects ${randomUUID()}` });
    const clientId = (made.body['detail'] as Record<string, unknown>)['clientId'];
    const holderId = (harness.world.mia as unknown as Member).personId;
    return { body: { holderId, collection: 'task', action: 'read', clientId } };
  }
  if (declaration.name === 'delegation.revoke') {
    const task = await harness.freshTask(`s0-5 effects ${randomUUID()}`);
    const decided = await harness.reserve(task, 'draft_the_effects_reply');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    return {
      body: { delegationId: (picked.body['detail'] as Record<string, unknown>)['delegationId'] },
    };
  }
  return await harness.positiveBody(declaration);
}

/** What is wrong with a declaration before it runs: a kind that is no table, or scoped too narrowly. */
function declaredFaults(
  declaration: CommandDeclaration,
  tables: ReadonlySet<string>,
  scoped: ReadonlySet<string>,
): string[] {
  const { name } = declaration;
  return COMMAND_EFFECTS[name].writes.flatMap((kind) => [
    ...(tables.has(kind.kind) ? [] : [`${name}: declares ${kind.kind}, which is no table`]),
    ...(kind.scope === 'business' && scoped.has(kind.kind)
      ? [`${name}: declares ${kind.kind} business-internal; it reaches a task or client`]
      : []),
  ]);
}

/** Runs the command on its fixture and names every table it changed that it does not declare. */
async function runFaults(declaration: CommandDeclaration): Promise<string[]> {
  const { name } = declaration;
  const prepared = await bodyFor(declaration);
  if ('exception' in prepared) return [`${name}: no fixture (${prepared.exception})`];
  const before = await fingerprint();
  const answer = await harness.asPerson(name, prepared.body);
  if (answer.code !== 'ok') return [`${name}: its fixture was refused ${answer.code}`];
  const after = await fingerprint();
  const written = [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );
  const declared = COMMAND_EFFECTS[name].writes;
  return [
    ...(declaration.kind === 'write' && written.length === 0 && !(name in NO_CHANGE)
      ? [`${name}: its fixture changed no row, so its declaration is unproved`]
      : []),
    ...written
      .filter((table) => !declared.some((kind) => kind.kind === table))
      .map((table) => `${name}: wrote ${table}, undeclared`),
  ];
}

/**
 * Write commands whose fixture changes no row, each with where its write is
 * proved instead. Any other write that changes nothing fails: its declaration
 * would be unproved.
 */
const NO_CHANGE: Readonly<Record<string, string>> = {
  'task.purge':
    'a fresh trash is inside the retention window; the purge is tests/commands/purge-retention.test.ts',
  'session.end':
    'a sign-out writes only its audit event; the browser ends the credential (tests/commands/c23-session-end.test.ts)',
};

describe.skipIf(serverUrl === undefined)('S0-5 gate coverage: the effect metadata, proved', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_effects');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 gate coverage (proved): each command changes only the record kinds it declares, at no narrower scope', async () => {
    const scoped = await clientScoped();
    const tables = new Set((await fingerprint()).keys());
    const found: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // One command at a time: the digest before and after must be this one's alone.
      // eslint-disable-next-line no-await-in-loop
      found.push(...declaredFaults(declaration, tables, scoped), ...(await runFaults(declaration)));
    }
    expect(found).toStrictEqual([]);
  }, 300_000);
});
