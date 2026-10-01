// SPDX-License-Identifier: AGPL-3.0-only
//
// Review FIX-2A (RP): find-copies follows the person's own id one hop only.
// Rows naming the person by their login or their acting id, and rows left
// naming an erased person's id, are never listed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('rev_rp_finder');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A person with an acting identity and a sign-in; answers the ids. */
async function plantSignedInPerson(name: string) {
  const { world } = harness;
  const ids = {
    person: randomUUID(),
    actor: randomUUID(),
    login: randomUUID(),
    link: randomUUID(),
    grant: randomUUID(),
  };
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(`insert into public.people (business_id, id, display_name) values ($1, $2, $3)`, [
      world.alpha,
      ids.person,
      name,
    ]);
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
      [world.alpha, ids.actor, ids.person],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, ids.login, `sub-${randomUUID()}`],
    );
    await tx.query(
      `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, ids.link, ids.login, ids.person, ids.actor],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $3)`,
      [world.alpha, ids.grant, ids.actor],
    );
  });
  return ids;
}

test('RP-1a find-copies lists the login row of a person found by name', async () => {
  const name = `qx7login${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Sam ${name}`);
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.code).toBe(0);
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(pairs, 'the person_logins link is found (one hop)').toContainEqual([
    'person_logins',
    ids.link,
  ]);
  expect(pairs, 'the logins row holding their sign-in subject').toContainEqual([
    'logins',
    ids.login,
  ]);
});

test('RP-1b find-copies lists a grant held by the person acting', async () => {
  const name = `qx7actor${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Lee ${name}`);
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual(['grants', ids.grant]);
});

test('RP-1c after the person row is erased, a row still naming their id is found by the re-search', async () => {
  const { world } = harness;
  const name = `qx7erase${randomUUID().slice(0, 8)}`;
  const person = randomUUID();
  const grant = randomUUID();
  const granter = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(`insert into public.people (business_id, id, display_name) values ($1, $2, $3)`, [
      world.alpha,
      person,
      `Kim ${name}`,
    ]);
    await tx.query(
      `insert into public.actors (business_id, id, kind) values ($1, $2, 'worker')`,
      [world.alpha, granter],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'business', 'tasks', 'read', $4)`,
      [world.alpha, grant, person, granter],
    );
  });
  const before = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(before.hits.map((hit) => [hit.table, hit.id]), 'listed before').toContainEqual([
    'grants',
    grant,
  ]);
  // The runbook's erasure step for a person: identifiers, then the people row.
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(`delete from public.people where id = $1`, [person]);
  });
  const after = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(after.hits.map((hit) => [hit.table, hit.id]), 'still naming them after').toContainEqual([
    'grants',
    grant,
  ]);
});
