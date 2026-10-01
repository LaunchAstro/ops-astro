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
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
      [world.alpha, ids.person, name],
    );
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

test('RP-1d find-copies by the email a person wrote from lists their membership', async () => {
  const { world } = harness;
  const mail = `qx7mail${randomUUID().slice(0, 8)}@example.test`;
  const person = randomUUID();
  const membership = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Alex Doe')`,
      [world.alpha, person],
    );
    await tx.query(
      `insert into public.person_identifiers
         (business_id, id, person_id, kind, value, observed_value, source_system)
       values ($1, $2, $3, 'email', $4, $4, 'dry-run')`,
      [world.alpha, randomUUID(), person, mail],
    );
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'staff')`,
      [world.alpha, membership, person],
    );
  });
  const found = await findCopies(adminUrl, ['--text', mail], 'alpha');
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(
    pairs.map(([table]) => table),
    'the identifier row is found',
  ).toContain('person_identifiers');
  expect(pairs, 'their membership').toContainEqual(['memberships', membership]);
});

test('RD-2 find-copies lists a row naming only the agent of a credential the person issued', async () => {
  const { world } = harness;
  const name = `qx7agent${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Kim ${name}`);
  const agent = randomUUID();
  const agentGrant = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [world.alpha, agent],
    );
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
          credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
               now() + interval '1 day')`,
      [world.alpha, randomUUID(), agent, ids.person, ids.actor, 'a'.repeat(64)],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $3)`,
      [world.alpha, agentGrant, agent],
    );
  });
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual(['grants', agentGrant]);
});
