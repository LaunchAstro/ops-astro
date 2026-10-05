// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's stored names (scripts/privacy/find-copies.mjs): a row
// naming one of the people found by their stored name alone is a copy,
// before and after an erasure (docs/local/PRIVACY-RUNBOOK.md, 'Every copy of
// a person' and 'Erasure').

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { findCopies } from './c81-privacy-runbook-finder.ts';
import {
  erasePerson,
  type FinderWorld,
  hitOn,
  openFinderWorld,
  pairs,
  plantPerson,
  word,
} from './find-copies-world.ts';

let world: FinderWorld;

beforeAll(async () => {
  world = await openFinderWorld('find_copies_names');
});

afterAll(async () => {
  await world?.db.drop();
});

const person = async (business: string, name: string) => await plantPerson(world, business, name);
const erase = async (personId: string) => await erasePerson(world, personId);

// oxlint-disable-next-line max-lines-per-function -- Sol's proof PRV-oa-956-R1.1, body kept as written
it('a row naming only the stored name of a person merged with the one named is found, and found again with the printed ids added', async () => {
  const a = randomUUID();
  const b = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name)
     values ($1, $2, 'Anna Current'), ($1, $3, 'Eleanor Previous')`,
    [world.alpha, a, b],
  );
  const operator = await plantPerson(world, world.alpha, 'Operator Cole');
  await world.db.admin.execute(
    `insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     values ($1, $2, $3, $4, $5, 'same person')`,
    [world.alpha, randomUUID(), a, b, operator.actor],
  );
  const incident = randomUUID();
  await world.db.admin.execute(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds, status,
        recorded_by_actor)
     values ($1, $2, 'Misrouted message', now(), 'Operator', 'Eleanor Previous',
             array['contact'], 'closed', $3)`,
    [world.alpha, incident, operator.actor],
  );

  // The runbook's runs: the name with --export; neither person has an
  // identifier, so there is no email or phone run.
  const byName = await findCopies(world.adminUrl, ['--text', 'Anna Current', '--export'], 'alpha');
  expect(byName.code).toBe(0);

  // The re-search: the same text with A's and B's printed --id flags.
  const flags = byName.stderr
    .split('\n')
    .filter((line) => line.includes(`for ${a} (`) || line.includes(`for ${b} (`))
    .flatMap((line) => (line.split('add: ')[1] ?? '').split(' '))
    .filter((part) => part !== '');
  expect(flags, 'A and B each print their --id flags').toContain(b);
  const again = await findCopies(
    world.adminUrl,
    ['--text', 'Anna Current', '--export', ...flags],
    'alpha',
  );
  expect(again.code).toBe(0);

  const holds = (hits: typeof byName.hits) =>
    pairs(hits).some(([table, id]) => table === 'privacy_incidents' && id === incident);
  expect({
    'every-copy inventory includes I': holds(byName.hits),
    're-search with printed --id flags includes I': holds(again.hits),
  }).toEqual({
    'every-copy inventory includes I': true,
    're-search with printed --id flags includes I': true,
  });
});

it('a stored name with fewer than four letters or digits is not searched, as the text would not be', async () => {
  const name = `Anna ${word('anna')}`;
  const named = await person(world.alpha, name);
  const short = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, 'Li')`,
    [world.alpha, short],
  );
  const operator = await person(world.alpha, `Operator ${word('op')}`);
  await world.db.admin.execute(
    `insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     values ($1, $2, $3, $4, $5, 'same person')`,
    [world.alpha, randomUUID(), named.id, short, operator.actor],
  );
  const incident = randomUUID();
  await world.db.admin.execute(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds, status,
        recorded_by_actor)
     values ($1, $2, 'Misrouted message', now(), 'Operator', 'Li', array['contact'], 'closed', $3)`,
    [world.alpha, incident, operator.actor],
  );
  const found = await findCopies(world.adminUrl, ['--text', name, '--export'], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits), 'the merged person is found by id').toContainEqual(['people', short]);
  expect(pairs(found.hits), 'a two-letter word is no name to search').not.toContainEqual([
    'privacy_incidents',
    incident,
  ]);
});

it("after an erasure, the runbook's run for a merged person's stored name still finds a row naming them by that name alone", async () => {
  const anna = `Anna ${word('anna')}`;
  const eleanor = `Eleanor ${word('eleanor')}`;
  const a = randomUUID();
  const b = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, $3), ($1, $4, $5)`,
    [world.alpha, a, anna, b, eleanor],
  );
  const operator = await person(world.alpha, `Operator ${word('op')}`);
  const mergeId = randomUUID();
  await world.db.admin.execute(
    `insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     values ($1, $2, $3, $4, $5, 'same person')`,
    [world.alpha, mergeId, a, b, operator.actor],
  );
  const incident = randomUUID();
  await world.db.admin.execute(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds, status,
        recorded_by_actor)
     values ($1, $2, 'Misrouted message', now(), 'Operator', $3, array['contact'], 'closed', $4)`,
    [world.alpha, incident, eleanor, operator.actor],
  );
  const before = await findCopies(world.adminUrl, ['--text', anna, '--export'], 'alpha');
  expect(hitOn(before.hits, 'privacy_incidents', incident)?.text).toBe(true);
  const flags = before.stderr
    .split('\n')
    .filter((line) => line.includes(`for ${a} (`) || line.includes(`for ${b} (`))
    .flatMap((line) => (line.split('add: ')[1] ?? '').split(' '))
    .filter((part) => part !== '');

  await world.db.admin.execute('delete from public.person_merges where id = $1', [mergeId]);
  await erase(b);
  await erase(a);

  const byFirstText = await findCopies(world.adminUrl, ['--text', anna, ...flags], 'alpha');
  expect(byFirstText.code).toBe(0);
  expect(pairs(byFirstText.hits), 'the stored name went with the people row').not.toContainEqual([
    'privacy_incidents',
    incident,
  ]);
  const byStoredName = await findCopies(world.adminUrl, ['--text', eleanor, ...flags], 'alpha');
  expect(byStoredName.code).toBe(0);
  expect(hitOn(byStoredName.hits, 'privacy_incidents', incident)?.text).toBe(true);
});
