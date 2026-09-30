// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved rather than trusted: every command in the
// catalogue is run once on its positive fixture (the role-case harness's
// recipes), and the tables whose rows changed are compared with the record
// kinds it declares. An undeclared write fails; so does a kind declared
// business-internal whose table reaches a task or a client through its
// foreign keys, since a row holding a task's id is a client-scoped write.
// The act's own bookkeeping (its audit event and its operation row) is the
// same for every command and is not a record kind. Two commands have no
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

/** Written by every command as the record of the act, never a record kind of its own. */
const BOOKKEEPING: ReadonlySet<string> = new Set(['audit_events', 'operations']);

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

/** The positive recipe, or one made here for the two commands that have none. */
async function bodyFor(declaration: CommandDeclaration): Promise<Prepared> {
  if (declaration.name === 'grant.revoke') {
    const mia = harness.world.mia as unknown as Member;
    const grantId = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) => await grantTo(tx, mia, 'comment'),
    );
    return { body: { grantId } };
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

describe.skipIf(serverUrl === undefined)('S0-5 gate coverage: the effect metadata, proved', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_effects');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 gate coverage (proved): each command changes only the record kinds it declares, at no narrower scope', async () => {
    const scoped = await clientScoped();
    const found: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      const { name } = declaration;
      const declared = COMMAND_EFFECTS[name].writes;
      for (const kind of declared) {
        if (kind.scope === 'business' && scoped.has(kind.kind)) {
          found.push(
            `${name}: declares ${kind.kind} business-internal; it reaches a task or client`,
          );
        }
      }
      // One command at a time: the digest before and after must be this one's alone.
      // eslint-disable-next-line no-await-in-loop
      const prepared = await bodyFor(declaration);
      if ('exception' in prepared) {
        found.push(`${name}: no fixture (${prepared.exception})`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const before = await fingerprint();
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asPerson(name, prepared.body);
      if (answer.code !== 'ok') {
        found.push(`${name}: its fixture was refused ${answer.code}`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const after = await fingerprint();
      const written = [...after.keys()].filter(
        (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
      );
      for (const table of written) {
        if (!declared.some((kind) => kind.kind === table))
          found.push(`${name}: wrote ${table}, undeclared`);
      }
    }
    expect(found).toStrictEqual([]);
  }, 300_000);
});
