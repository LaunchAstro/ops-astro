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
const hex = () => randomUUID().replaceAll('-', '');

it('the text is searched without the spaces around it, and a run of spaces of any kind in it is one space', async () => {
  const tess = word('tess');
  const clients = [randomUUID(), randomUUID()];
  const author = await person(world.alpha, `Ola ${word('ola')}`);
  await world.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2, $4, $6), ($1, $3, $5, $6)`,
    [world.alpha, ...clients, `Call ${tess}  Lee.`, `Ring ${tess}\u00A0\u2009Lee.`, author.actor],
  );
  for (const text of [
    `${tess} Lee`,
    `\u00A0${tess} \t Lee `,
    `${tess}\u00A0Lee`,
    `${tess}\u3000Lee`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const found = await findCopies(world.adminUrl, ['--text', text], 'alpha');
    expect(found.code, text).toBe(0);
    expect(pairs(found.hits), text).toContainEqual(['clients', clients[0]]);
    expect(pairs(found.hits), text).toContainEqual(['clients', clients[1]]);
  }
});

it('after an erasure, a row naming only an id given back with --id is marked given, so it never passes for another person', async () => {
  const gus = word('gus');
  const erased = await person(world.alpha, `Gus ${gus}`);
  const granter = await person(world.alpha, `Ida ${word('ida')}`);
  const grant = randomUUID();
  await world.db.admin.execute(
    `insert into public.grants
       (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
     values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $4)`,
    [world.alpha, grant, erased.actor, granter.actor],
  );
  const before = await findCopies(world.adminUrl, ['--text', gus], 'alpha');
  const flags = /--id \S+(?: --id \S+)*/u.exec(before.stderr)?.[0] ?? '';
  expect(flags).toContain(erased.actor);
  for (const table of ['memberships', 'actors', 'people']) {
    // oxlint-disable-next-line no-await-in-loop
    await world.db.admin.execute(
      `delete from public.${table} where ${table === 'people' ? 'id' : 'person_id'} = $1`,
      [erased.id],
    );
  }
  const after = await findCopies(world.adminUrl, ['--text', gus, ...flags.split(' ')], 'alpha');
  expect(after.code).toBe(0);
  const hit = hitOn(after.hits, 'grants', grant);
  expect(hit?.text).toBe(false);
  expect(hit?.given, 'the row holds an id the operator gave back for the erased person').toBe(true);
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

it('an export withholds credential hashes, the security material of the business', async () => {
  const kit = word('kit');
  const issuer = await person(world.alpha, `Kit ${kit}`);
  const agent = randomUUID();
  const credential = randomUUID();
  const hash = `${hex()}${hex()}`;
  const delegationHash = `${hex()}${hex()}`;
  const delegation = randomUUID();
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
  await world.db.admin.execute(
    `insert into public.delegations
       (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
        collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
     values ($1, $2, $3, $4, $5, 'triage', array['tasks'], array['read'], $6,
             now() + interval '1 day', 'record', $7)`,
    [world.alpha, delegation, agent, issuer.id, issuer.actor, delegationHash, randomUUID()],
  );
  const found = await findCopies(world.adminUrl, ['--text', kit, '--export'], 'alpha');
  expect(found.code).toBe(0);
  expect(hitOn(found.hits, 'agent_credentials', credential)?.row?.['credential_hash']).toBe(
    'withheld',
  );
  expect(hitOn(found.hits, 'delegations', delegation)?.row?.['credential_hash']).toBe('withheld');
  expect(found.stdout).not.toContain(hash);
  expect(found.stdout).not.toContain(delegationHash);
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
    ['--text', 'a  b'],
    ['--text', 'a, b'],
    ['--text', 'a.-b'],
    ['--text', '\u200Ba b\u200B'],
    ['--text', '\u00A0a\u00A0\u00A0b\u00A0'],
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
