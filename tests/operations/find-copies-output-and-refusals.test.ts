// SPDX-License-Identifier: AGPL-3.0-only
//
// What the copy finder (scripts/privacy/find-copies.mjs) prints and what it
// refuses: the text as given, a whole export, a credential hash withheld, a
// table it cannot vouch for, a malformed command line and a malformed
// database address, whose password it never prints.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { findCopies } from './c81-privacy-runbook-finder.ts';
import {
  type FinderWorld,
  hitOn,
  openFinderWorld,
  pairs,
  plantPerson,
  word,
} from './find-copies-world.ts';

const run = promisify(execFile);
const FINDER = new URL('../../scripts/privacy/find-copies.mjs', import.meta.url).pathname;

let world: FinderWorld;

beforeAll(async () => {
  world = await openFinderWorld('find_copies_output');
});

afterAll(async () => {
  await world?.db.drop();
});

const person = async (business: string, name: string) => await plantPerson(world, business, name);

it('the text is searched without the spaces around it', async () => {
  const tess = word('tess');
  const client = randomUUID();
  const author = await person(world.alpha, `Ola ${word('ola')}`);
  await world.db.admin.execute(
    'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
    [world.alpha, client, `Call ${tess}.`, author.actor],
  );
  const found = await findCopies(world.adminUrl, ['--text', `  ${tess}  `], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['clients', client]);
});

it('a large export reaches its reader whole', async () => {
  const bulk = word('bulk');
  const filler = 'x'.repeat(20_000);
  const planted = await Promise.all(
    Array.from({ length: 120 }, async () => await person(world.alpha, `${bulk} ${filler}`)),
  );
  const found = await findCopies(world.adminUrl, ['--text', bulk, '--export'], 'alpha');
  expect(found.code).toBe(0);
  const people = found.hits.filter((hit) => hit.table === 'people').map((hit) => hit.id);
  expect(people.toSorted()).toEqual(planted.map((each) => each.id).toSorted());
  expect(found.hits.filter((hit) => hit.table === 'memberships')).toHaveLength(120);
});

it('an export withholds a credential hash, the security material of the business', async () => {
  const kit = word('kit');
  const issuer = await person(world.alpha, `Kit ${kit}`);
  const agent = randomUUID();
  const credential = randomUUID();
  const hash = `h${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`.slice(
    0,
    64,
  );
  await world.db.admin.execute(
    "insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')",
    [world.alpha, agent],
  );
  await world.db.admin.execute(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id,
        purpose, scope, credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6,
             'hmac-sha256-v1', 'k1', now() + interval '1 day')`,
    [world.alpha, credential, agent, issuer.id, issuer.actor, hash],
  );
  const found = await findCopies(world.adminUrl, ['--text', kit, '--export'], 'alpha');
  expect(found.code).toBe(0);
  expect(hitOn(found.hits, 'agent_credentials', credential)?.row?.['credential_hash']).toBe(
    'withheld',
  );
  expect(found.stdout).not.toContain(hash);
});

it('a materialised view or foreign table in public is refused, since the finder cannot vouch for its rows', async () => {
  await world.db.admin.execute(
    'create materialized view public.people_copy as select business_id, id, display_name from public.people',
  );
  try {
    const found = await findCopies(world.adminUrl, ['--text', 'Casey'], 'alpha');
    expect({ code: found.code, stdout: found.stdout }).toEqual({ code: 1, stdout: '' });
    expect(found.stderr).toContain('people_copy');
  } finally {
    await world.db.admin.execute('drop materialized view public.people_copy');
  }
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
    ['--text', '--export'],
    ['--id', '--export'],
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
