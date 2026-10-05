// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';

let db: FreshDatabase;
let adminUrl: string;
const alpha = randomUUID();
const bravo = randomUUID();

beforeAll(async () => {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('Sol proof requires a throwaway Postgres server');
  db = await createFreshDatabase({ part: 'sol_ow068', serverUrl });
  const url = new URL(serverUrl);
  url.pathname = `/${db.name}`;
  adminUrl = url.toString();
  await db.admin.execute(
    `insert into public.businesses (business_id, id, key, name)
     values ($1, $1, 'alpha', 'alpha'), ($2, $2, 'bravo', 'bravo')`,
    [alpha, bravo],
  );
});

afterAll(async () => {
  await db?.drop();
});

async function person(business: string, name: string) {
  const id = randomUUID();
  const actor = randomUUID();
  await db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [business, id, name],
  );
  await db.admin.execute(
    "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)",
    [business, actor, id],
  );
  return { id, actor };
}

async function clientGrant(holder: Awaited<ReturnType<typeof person>>, clientName: string) {
  const client = randomUUID();
  const grant = randomUUID();
  await db.admin.execute(
    'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
    [alpha, client, clientName, holder.actor],
  );
  await db.admin.execute(
    `insert into public.grants
       (business_id, id, subject_kind, subject_id, scope_kind, scope_id,
        collection, action, granted_by_actor_id)
     values ($1, $2, 'actor', $3, 'party', $4, 'tasks', 'read', $3)`,
    [alpha, grant, holder.actor, client],
  );
  return { client, grant };
}

it('person to person and client to client export excludes grants matched only by JSON field names', async () => {
  const requested = await person(alpha, 'Grant');
  const unrelated = await person(alpha, `Taylor ${randomUUID()}`);
  const own = await clientGrant(requested, `Requested client ${randomUUID()}`);
  const foreign = await clientGrant(unrelated, `Private client ${randomUUID()}`);
  const [stored] = await db.admin.execute<{ readonly row: Record<string, unknown> }>(
    'select to_jsonb(t) as row from public.grants t where id = $1',
    [foreign.grant],
  );
  if (stored === undefined) throw new Error('The unrelated grant was not planted');
  const values = JSON.stringify(Object.values(stored.row)).toLowerCase();
  expect(values).not.toContain('grant');
  expect(values).not.toContain(requested.id);
  expect(values).not.toContain(requested.actor);
  const found = await findCopies(adminUrl, ['--text', 'Grant', '--export'], 'alpha');
  expect(found.code).toBe(0);
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(pairs).toContainEqual(['grants', own.grant]);
  expect(pairs).toContainEqual(['people', requested.id]);
  expect(pairs).not.toContainEqual(['people', unrelated.id]);
  expect(
    pairs,
    'The other person and client grant holds neither Grant nor an id of the requested person',
  ).not.toContainEqual(['grants', foreign.grant]);
});

it('business to business export excludes a same-named person and their issued agent', async () => {
  const name = `SolBusiness${randomUUID()}`;
  const own = await person(alpha, name);
  const other = await person(bravo, name);
  const agent = randomUUID();
  await db.admin.execute(
    "insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')",
    [bravo, agent],
  );
  await db.admin.execute(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id,
        purpose, scope, credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6,
             'hmac-sha256-v1', 'k1', now() + interval '1 day')`,
    [bravo, randomUUID(), agent, other.id, other.actor, 'a'.repeat(64)],
  );
  const found = await findCopies(adminUrl, ['--text', name, '--export'], 'alpha');
  expect(found.code).toBe(0);
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual(['people', own.id]);
  expect(found.hits.every((hit) => hit.row?.['business_id'] === alpha)).toBe(true);
  expect(found.stdout).not.toContain(other.id);
  expect(found.stdout).not.toContain(agent);
  expect(found.stdout).not.toContain(bravo);
});
