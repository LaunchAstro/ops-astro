// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's seeds (scripts/privacy/find-copies.mjs): which people a
// request's text stands for, which ids follow from them, and how the search
// after an erasure keeps those ids once the person's own rows are gone
// (docs/local/PRIVACY-RUNBOOK.md, 'Every copy of a person' and 'Erasure').
// Every case plants two people or two businesses whose rows link to each
// other, so a seed that crosses to the wrong person shows in the list.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { findCopies } from './c81-privacy-runbook-finder.ts';
import {
  erasePerson,
  type FinderWorld,
  hitOn,
  openFinderWorld,
  pairs,
  plantIdentifier,
  plantPerson,
  word,
} from './find-copies-world.ts';

let world: FinderWorld;

beforeAll(async () => {
  world = await openFinderWorld('find_copies_seeds');
});

afterAll(async () => {
  await world?.db.drop();
});

const person = async (business: string, name: string) => await plantPerson(world, business, name);
const identifier = async (personId: string, value: string, reviewState: string) =>
  await plantIdentifier(world, personId, value, reviewState);

it('a name seeds the person it names as a whole word, never another whose name only contains it', async () => {
  const anna = word('anna');
  const requested = await person(world.alpha, `${anna} Lee`);
  const other = await person(world.alpha, `Jo${anna} Lee`);
  const found = await findCopies(world.adminUrl, ['--text', anna], 'alpha');
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
  expect(hitOn(found.hits, 'people', other.id)?.text).toBe(true);
});

it('a rejected identifier holding the text seeds no one, and a confirmed one seeds its person', async () => {
  const mail = `${word('shared')}@example.test`;
  const owner = await person(world.alpha, `Rhea ${word('rhea')}`);
  const refused = await person(world.alpha, `Bo ${word('bo')}`);
  await identifier(owner.id, mail, 'confirmed');
  const rejected = await identifier(refused.id, mail, 'rejected');
  const found = await findCopies(world.adminUrl, ['--text', mail], 'alpha');
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
  const former = await person(world.alpha, `Ines ${ines}`);
  const current = await person(world.alpha, `Bert ${word('bert')}`);
  const login = randomUUID();
  const formerLink = randomUUID();
  const currentLink = randomUUID();
  await world.db.admin.execute(
    `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
    [world.alpha, login, `sub-${randomUUID()}`],
  );
  await world.db.admin.execute(
    `insert into public.person_logins
       (business_id, id, login_id, person_id, linked_by_actor_id, active, deactivated_at)
     values ($1, $2, $4, $5, $6, false, now()), ($1, $3, $4, $7, $8, true, null)`,
    [
      world.alpha,
      formerLink,
      currentLink,
      login,
      former.id,
      former.actor,
      current.id,
      current.actor,
    ],
  );
  const found = await findCopies(world.adminUrl, ['--text', ines], 'alpha');
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
  const requested = await person(world.alpha, `Ugo ${ugo}`);
  const other = await person(world.alpha, `Vera ${word('vera')}`);
  const client = randomUUID();
  await world.db.admin.execute(
    'insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)',
    [world.alpha, client, `Referred by ${requested.id.toUpperCase()}`, other.actor],
  );
  const found = await findCopies(world.adminUrl, ['--text', ugo], 'alpha');
  expect(found.code).toBe(0);
  const hit = hitOn(found.hits, 'clients', client);
  expect(hit?.columns).toEqual(['name']);
  expect(hit?.people).toEqual([requested.id]);
});

/**
 * A person found by name, with an identifier, a grant naming them by id alone
 * in alpha and in bravo, and a same-named person in bravo.
 */
async function plantErasable() {
  const erin = word('erin');
  const erased = randomUUID();
  const granter = await person(world.alpha, `Gail ${word('gail')}`);
  const bravoGranter = await person(world.bravo, `Hal ${word('hal')}`);
  await world.db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [world.alpha, erased, `Erin ${erin}`],
  );
  await identifier(erased, `${erin}@example.test`, 'confirmed');
  const grants = { alpha: randomUUID(), bravo: randomUUID() };
  for (const [business, grant, by] of [
    [world.alpha, grants.alpha, granter.actor],
    [world.bravo, grants.bravo, bravoGranter.actor],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await world.db.admin.execute(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'business', 'tasks', 'read', $4)`,
      [business, grant, erased, by],
    );
  }
  // The same name in bravo, so a seed taken across businesses shows in the printed ids.
  const bravoTwin = await person(world.bravo, `Erin ${erin}`);
  await world.db.admin.execute(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system)
     values ($1, $2, $3, 'email', $4, $4, 'dry-run')`,
    [world.bravo, randomUUID(), bravoTwin.id, erin],
  );
  return { erin, erased, grants, bravoTwin };
}

const erase = async (personId: string) => await erasePerson(world, personId);

it('after an erasure, the search with the ids the first list printed still finds a row naming the person by id alone, and only in its business', async () => {
  const { erin, erased, grants, bravoTwin } = await plantErasable();
  const before = await findCopies(world.adminUrl, ['--text', erin], 'alpha');
  expect(pairs(before.hits)).toContainEqual(['grants', grants.alpha]);
  const printed = /--id \S+(?: --id \S+)*/u.exec(before.stderr)?.[0];
  expect(printed, 'the first list prints the ids to search with after the erasure').toBeDefined();
  expect(printed).toContain(erased);
  expect(before.stderr).not.toContain(bravoTwin.id);
  expect(before.stderr).not.toContain(bravoTwin.actor);
  await erase(erased);
  const byName = await findCopies(world.adminUrl, ['--text', erin], 'alpha');
  expect(pairs(byName.hits), 'the name alone no longer reaches the grant').toEqual([]);
  const after = await findCopies(
    world.adminUrl,
    ['--text', erin, ...(printed ?? '').split(' ')],
    'alpha',
  );
  expect(after.code).toBe(0);
  expect(pairs(after.hits)).toEqual([['grants', grants.alpha]]);
  expect(hitOn(after.hits, 'grants', grants.alpha)?.people).toEqual([erased]);
  expect(hitOn(after.hits, 'grants', grants.alpha)?.text, 'found by id alone').toBe(false);
  expect(after.stdout).not.toContain(grants.bravo);
  expect(after.stdout).not.toContain(world.bravo);
});

it('after an erasure, the id alone in any letter case finds the row naming the person and nothing else', async () => {
  const { erased, grants } = await plantErasable();
  await erase(erased);
  for (const id of [erased, erased.toUpperCase()]) {
    // oxlint-disable-next-line no-await-in-loop
    const byId = await findCopies(world.adminUrl, ['--id', id], 'alpha');
    expect(byId.code, id).toBe(0);
    expect(pairs(byId.hits), id).toEqual([['grants', grants.alpha]]);
    expect(byId.stderr, id).toContain(`${erased} (given by --id)`);
  }
});

/** A merge of `absorbed` into `surviving`, reversed or standing. */
async function merge(
  business: string,
  surviving: { readonly id: string; readonly actor: string },
  absorbed: { readonly id: string },
  reversed: boolean,
) {
  await world.db.admin.execute(
    `insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence,
        reversed_at, reversed_by_actor_id, reversal_evidence)
     values ($1, $2, $3, $4, $5, 'same phone',
             case when $6 then now() end, case when $6 then $5::uuid end,
             case when $6 then 'different people' end)`,
    [business, randomUUID(), surviving.id, absorbed.id, surviving.actor, reversed],
  );
}

it('an id given for another business follows none of its merges', async () => {
  const first = await person(world.bravo, `Nia ${word('nia')}`);
  const second = await person(world.bravo, `Noa ${word('noa')}`);
  await merge(world.bravo, first, second, false);
  const found = await findCopies(world.adminUrl, ['--id', first.id], 'alpha');
  expect(found.code).toBe(0);
  expect(found.stderr).not.toContain(second.id);
  expect(found.stderr).not.toContain(second.actor);
});

it('a person merged into another is the same person: the merge is followed, a reversed one is not', async () => {
  const mia = word('mia');
  const requested = await person(world.alpha, `Mia ${mia}`);
  const absorbed = await person(world.alpha, `M. ${word('m')}`);
  const unmerged = await person(world.alpha, `Max ${word('max')}`);
  const duplicate = await person(world.alpha, `Mia ${mia} Jr`);
  await merge(world.alpha, requested, absorbed, false);
  await merge(world.alpha, requested, duplicate, false);
  await merge(world.alpha, requested, unmerged, true);
  const found = await findCopies(world.adminUrl, ['--text', mia], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['memberships', absorbed.membership]);
  expect(hitOn(found.hits, 'memberships', absorbed.membership)?.people).toEqual([absorbed.id]);
  const line = (id: string) =>
    found.stderr.split('\n').find((each) => each.includes(`for ${id} (`));
  expect(line(requested.id)).toContain(
    `(named by the text; merged with ${[absorbed.id, duplicate.id].toSorted().join('; merged with ')})`,
  );
  expect(line(absorbed.id)).toContain(`(merged with ${requested.id})`);
  expect(line(duplicate.id)).toContain(`(named by the text; merged with ${requested.id})`);
  expect(pairs(found.hits), 'the reversed merge joins no one').not.toContainEqual([
    'memberships',
    unmerged.membership,
  ]);
});

it('a text naming two people prints the ids of each on a line of its own', async () => {
  const mail = `${word('family')}@example.test`;
  const first = await person(world.alpha, `Pat ${word('pat')}`);
  const second = await person(world.alpha, `Sam ${word('sam')}`);
  await identifier(first.id, mail, 'confirmed');
  await identifier(second.id, mail, 'observed');
  const found = await findCopies(world.adminUrl, ['--text', mail], 'alpha');
  expect(found.code).toBe(0);
  const lines = found.stderr.split('\n').filter((line) => line.includes('--id '));
  expect(lines).toHaveLength(2);
  for (const [own, other] of [
    [first, second],
    [second, first],
  ] as const) {
    const line = lines.find((each) => each.includes(own.id));
    expect(line).toContain(own.actor);
    expect(line).not.toContain(other.id);
    expect(line).not.toContain(other.actor);
  }
});
