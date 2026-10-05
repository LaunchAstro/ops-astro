// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's seeds (scripts/privacy/find-copies.mjs): which people a
// request's text stands for, which ids follow from them, and how the search
// after an erasure keeps those ids once the person's own rows are gone
// (docs/local/PRIVACY-RUNBOOK.md, 'Every copy of a person' and 'Erasure').
// Every case plants two people or two businesses whose rows link to each
// other, so a seed that crosses to the wrong person shows in the list.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { findCopies, type Hit } from './c81-privacy-runbook-finder.ts';

const run = promisify(execFile);
const FINDER = new URL('../../scripts/privacy/find-copies.mjs', import.meta.url).pathname;

let db: FreshDatabase;
let adminUrl: string;
const alpha = randomUUID();
const bravo = randomUUID();

beforeAll(async () => {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('The finder cases need a throwaway Postgres server');
  db = await createFreshDatabase({ part: 'find_copies_seeds', serverUrl });
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

/** A word no other case plants, so each case's text names its own people only. */
const word = (stem: string) => `${stem}${randomUUID().slice(0, 8)}`;

async function person(business: string, name: string) {
  const id = randomUUID();
  const actor = randomUUID();
  const membership = randomUUID();
  await db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [business, id, name],
  );
  await db.admin.execute(
    "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)",
    [business, actor, id],
  );
  await db.admin.execute(
    "insert into public.memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'staff')",
    [business, membership, id],
  );
  return { id, actor, membership };
}

async function identifier(personId: string, value: string, reviewState: string) {
  const id = randomUUID();
  await db.admin.execute(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, $2, $3, 'email', $4, $4, 'dry-run', $5)`,
    [alpha, id, personId, value, reviewState],
  );
  return id;
}

const pairs = (hits: readonly Hit[]) => hits.map((hit) => [hit.table, hit.id]);
const hitOn = (hits: readonly Hit[], table: string, id: string) =>
  hits.find((hit) => hit.table === table && hit.id === id);

it('a name seeds the person it names as a whole word, never another whose name only contains it', async () => {
  const anna = word('anna');
  const requested = await person(alpha, `${anna} Lee`);
  const other = await person(alpha, `Jo${anna} Lee`);
  const found = await findCopies(adminUrl, ['--text', anna], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['memberships', requested.membership]);
  expect(hitOn(found.hits, 'memberships', requested.membership)?.people).toEqual([requested.id]);
  expect(
    pairs(found.hits),
    'the other person holds the text inside a longer word, so nothing naming them by id is theirs to list',
  ).not.toContainEqual(['memberships', other.membership]);
  expect(pairs(found.hits)).not.toContainEqual(['actors', other.actor]);
  // Their own row holds the text, so it is listed, and the hit says it stands for no one found.
  expect(hitOn(found.hits, 'people', other.id)?.people).toEqual([]);
});

it('a rejected identifier holding the text seeds no one, and a confirmed one seeds its person', async () => {
  const mail = `${word('shared')}@example.test`;
  const owner = await person(alpha, `Rhea ${word('rhea')}`);
  const refused = await person(alpha, `Bo ${word('bo')}`);
  await identifier(owner.id, mail, 'confirmed');
  const rejected = await identifier(refused.id, mail, 'rejected');
  const found = await findCopies(adminUrl, ['--text', mail], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['memberships', owner.membership]);
  expect(pairs(found.hits), 'the rejected link names another person').not.toContainEqual([
    'memberships',
    refused.membership,
  ]);
  expect(hitOn(found.hits, 'person_identifiers', rejected)?.people).toEqual([]);
});

it('a login the person no longer holds seeds nothing, so its next holder stays off the list', async () => {
  const ines = word('ines');
  const former = await person(alpha, `Ines ${ines}`);
  const current = await person(alpha, `Bert ${word('bert')}`);
  const login = randomUUID();
  const formerLink = randomUUID();
  const currentLink = randomUUID();
  await db.admin.execute(
    `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
    [alpha, login, `sub-${randomUUID()}`],
  );
  await db.admin.execute(
    `insert into public.person_logins
       (business_id, id, login_id, person_id, linked_by_actor_id, active, deactivated_at)
     values ($1, $2, $4, $5, $6, false, now()), ($1, $3, $4, $7, $8, true, null)`,
    [alpha, formerLink, currentLink, login, former.id, former.actor, current.id, current.actor],
  );
  const found = await findCopies(adminUrl, ['--text', ines], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits), 'their own past link names them').toContainEqual([
    'person_logins',
    formerLink,
  ]);
  expect(pairs(found.hits)).not.toContainEqual(['person_logins', currentLink]);
  expect(pairs(found.hits)).not.toContainEqual(['logins', login]);
});

it('a row holding the person id in capitals is found, and says which person it stands for', async () => {
  const ugo = word('ugo');
  const requested = await person(alpha, `Ugo ${ugo}`);
  const other = await person(alpha, `Vera ${word('vera')}`);
  const client = randomUUID();
  await db.admin.execute(
    'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
    [alpha, client, `Referred by ${requested.id.toUpperCase()}`, other.actor],
  );
  const found = await findCopies(adminUrl, ['--text', ugo], 'alpha');
  expect(found.code).toBe(0);
  const hit = hitOn(found.hits, 'clients', client);
  expect(hit?.columns).toEqual(['name']);
  expect(hit?.people).toEqual([requested.id]);
});

it('after an erasure, the search with the ids the first list printed still finds a row naming the person by id alone, and only in its business', async () => {
  const erin = word('erin');
  const erased = randomUUID();
  const granter = await person(alpha, `Gail ${word('gail')}`);
  const bravoGranter = await person(bravo, `Hal ${word('hal')}`);
  await db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [alpha, erased, `Erin ${erin}`],
  );
  await identifier(erased, `${erin}@example.test`, 'confirmed');
  const grants = { alpha: randomUUID(), bravo: randomUUID() };
  for (const [business, grant, by] of [
    [alpha, grants.alpha, granter.actor],
    [bravo, grants.bravo, bravoGranter.actor],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await db.admin.execute(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'business', 'tasks', 'read', $4)`,
      [business, grant, erased, by],
    );
  }
  const before = await findCopies(adminUrl, ['--text', erin], 'alpha');
  expect(pairs(before.hits)).toContainEqual(['grants', grants.alpha]);
  const printed = /--id \S+(?: --id \S+)*/u.exec(before.stderr)?.[0];
  expect(printed, 'the first list prints the ids to search with after the erasure').toBeDefined();
  expect(printed).toContain(erased);
  await db.admin.execute('delete from public.person_identifiers where person_id = $1', [erased]);
  await db.admin.execute('delete from public.people where id = $1', [erased]);
  const byName = await findCopies(adminUrl, ['--text', erin], 'alpha');
  expect(pairs(byName.hits), 'the name alone no longer reaches the grant').toEqual([]);
  const after = await findCopies(
    adminUrl,
    ['--text', erin, ...(printed ?? '').split(' ')],
    'alpha',
  );
  expect(after.code).toBe(0);
  expect(pairs(after.hits)).toEqual([['grants', grants.alpha]]);
  expect(hitOn(after.hits, 'grants', grants.alpha)?.people).toEqual([erased]);
  expect(after.stdout).not.toContain(grants.bravo);
  expect(after.stdout).not.toContain(bravo);
});

it('the finder refuses an id that is not a UUID, a repeated option and an unknown one, before it connects', async () => {
  const id = randomUUID();
  for (const args of [
    ['--id', 'not-an-id'],
    ['--id', `{${id}}`],
    ['--id', id.replaceAll('-', '')],
    ['--id', `${id}x`],
    ['--id', `${id.slice(0, 35)}g`],
    ['--id'],
    ['--text', 'Casey', '--text', 'Riley'],
    ['--text', 'Casey', '--export', '--export'],
    ['--text', 'Casey', '--business', 'bravo'],
    ['--text', 'Casey', '--Export'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await findCopies('postgres://finder:unused@127.0.0.1:1/none', args, 'alpha');
    expect({ code: refused.code, stdout: refused.stdout }, args.join(' ')).toEqual({
      code: 2,
      stdout: '',
    });
  }
});

it('a malformed database address fails the search without printing its password', async () => {
  const password = `pw${randomUUID().replaceAll('-', '')}`;
  for (const url of [
    `postgres://finder:${password}@[::1:5432/db`,
    `postgres://finder:${password}@localhost:99999/db`,
    `postgres://finder:${password}@127.0.0.1:1/db`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const done = await run('node', [FINDER, '--business', 'alpha', '--text', 'Casey'], {
      env: { ...process.env, DATABASE_ADMIN_URL: url },
    }).then(
      (out) => ({ code: 0, ...out }),
      (error: { readonly code?: number; readonly stdout?: string; readonly stderr?: string }) => ({
        code: error.code ?? -1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );
    expect(done.code, url).toBe(1);
    expect(done.stdout).toBe('');
    expect(done.stderr).toContain('find-copies:');
    expect(`${done.stdout}${done.stderr}`).not.toContain(password);
  }
});
