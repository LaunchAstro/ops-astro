// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's values too long for the database's text-search parser
// (scripts/privacy/find-copies.mjs, Sol R2.1): a long value, a long stored
// name or a long query is still searched, looser rather than narrower, never
// failing the search, and the summary says what was matched loosely or not
// at all (docs/local/PRIVACY-RUNBOOK.md, 'Every copy of a person').

import { randomUUID } from 'node:crypto';
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

let world: FinderWorld;

beforeAll(async () => {
  world = await openFinderWorld('find_copies_long');
});

afterAll(async () => {
  await world?.db.drop();
});

const person = async (business: string, name: string) => await plantPerson(world, business, name);

/** Over a million bytes of words no case names: more than the parser's vector holds. */
const LONG = `(select string_agg('w' || lpad(i::text, 8, '0'), ' ' order by i)
                 from generate_series(1, 300000) i)`;

/** A record in alpha whose one value is LONG followed by `tail`; answers its id. */
async function plantLongRecord(tail: string): Promise<string> {
  const type = randomUUID();
  const record = randomUUID();
  await world.db.admin.execute(
    `insert into public.record_types (business_id, id, key, name, origin, retention_class)
     values ($1, $2, $3, 'Long value', 'preset', 'work')`,
    [world.alpha, type, `long_${type.replaceAll('-', '').slice(0, 12)}`],
  );
  await world.db.admin.execute(
    `insert into public.records (business_id, id, record_type_id, data)
     values ($1, $2, $3, jsonb_build_object('payload', ${LONG} || $4))`,
    [world.alpha, record, type, tail],
  );
  return record;
}

it('a value too long for the parser to read whole is still searched for a stored name, and stops no search', async () => {
  const name = `Anna ${word('anna')}`;
  const named = await person(world.alpha, name);
  const holding = await plantLongRecord(` ${name}`);
  const unrelated = await plantLongRecord('');
  const found = await findCopies(world.adminUrl, ['--id', named.id], 'alpha');
  expect(found.stderr).not.toContain('the search failed');
  expect(found.code).toBe(0);
  expect(pairs(found.hits), 'the person is listed').toContainEqual(['people', named.id]);
  expect(hitOn(found.hits, 'records', holding)?.text, 'the name, past the 16,383rd word').toBe(
    true,
  );
  expect(pairs(found.hits), 'a long value naming no one is not').not.toContainEqual([
    'records',
    unrelated,
  ]);
}, 180_000);

it('a name or observed address too long for the parser stops no search by the text, and one holding the text names its person', async () => {
  const name = `Anna ${word('anna')}`;
  const named = await person(world.alpha, name);
  const holder = await person(world.alpha, `Holder ${word('holder')}`);
  const bystander = await person(world.alpha, `Bystander ${word('bystander')}`);
  const longName = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, ${LONG})`,
    [world.alpha, longName],
  );
  await world.db.admin.execute(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, $2, $3, 'email', $4, ${LONG} || $5, 'dry-run', 'observed'),
            ($1, $6, $7, 'email', $8, ${LONG}, 'dry-run', 'observed')`,
    [
      world.alpha,
      randomUUID(),
      holder.id,
      `${word('holder')}@example.test`,
      ` ${name}`,
      randomUUID(),
      bystander.id,
      `${word('bystander')}@example.test`,
    ],
  );
  const found = await findCopies(world.adminUrl, ['--text', name], 'alpha');
  expect(found.stderr).not.toContain('the search failed');
  expect(found.code).toBe(0);
  expect(pairs(found.hits), 'the person named').toContainEqual(['people', named.id]);
  expect(pairs(found.hits), 'the person whose long address holds the text').toContainEqual([
    'people',
    holder.id,
  ]);
  expect(pairs(found.hits), 'a long name naming no one').not.toContainEqual(['people', longName]);
  expect(pairs(found.hits), 'a long address naming no one').not.toContainEqual([
    'people',
    bystander.id,
  ]);
}, 180_000);

it("a stored name too long for the parser is not searched, the summary says so, and the person's rows are found by id", async () => {
  const id = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, ${LONG})`,
    [world.alpha, id],
  );
  const found = await findCopies(world.adminUrl, ['--id', id], 'alpha');
  expect(found.stderr).not.toContain('the search failed');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['people', id]);
  expect(found.stderr).toContain(`${id}'s stored name is over 16,000 bytes`);
}, 180_000);

it('a stored name of thousands of short words is still searched, and stops no search', async () => {
  const id = randomUUID();
  const record = randomUUID();
  const type = randomUUID();
  // About 11,700 words in under 16,000 bytes: hyphenated pairs, each a word and its two parts.
  const stored = Array.from({ length: 3900 }, () => 'a-b').join(' ');
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
    [world.alpha, id, stored],
  );
  await world.db.admin.execute(
    `insert into public.record_types (business_id, id, key, name, origin, retention_class)
     values ($1, $2, $3, 'Deep name', 'preset', 'work')`,
    [world.alpha, type, `deep_${type.replaceAll('-', '').slice(0, 12)}`],
  );
  await world.db.admin.execute(
    `insert into public.records (business_id, id, record_type_id, data)
     values ($1, $2, $3, jsonb_build_object('note', $4::text))`,
    [world.alpha, record, type, `About ${stored}.`],
  );
  const found = await findCopies(world.adminUrl, ['--id', id], 'alpha');
  expect(found.stderr).not.toContain('the search failed');
  expect(found.code).toBe(0);
  expect(hitOn(found.hits, 'records', record)?.text, 'the record holding the name').toBe(true);
}, 180_000);

it('a person named by the text only loosely, in a value too long to read as words, is marked so', async () => {
  const stem = word('anna');
  const named = await person(world.alpha, `${stem} Lee`);
  const loose = await person(world.alpha, `Loose ${word('loose')}`);
  await world.db.admin.execute(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, $2, $3, 'email', $4, ${LONG} || $5, 'dry-run', 'observed')`,
    [world.alpha, randomUUID(), loose.id, `${word('loose')}@example.test`, ` jo${stem} leeds`],
  );
  const found = await findCopies(world.adminUrl, ['--text', `${stem} Lee`], 'alpha');
  expect(found.code).toBe(0);
  const line = (id: string) =>
    found.stderr.split('\n').find((text) => text.includes(`search again for ${id} `));
  expect(line(named.id), 'a whole-word match').toContain('(named by the text)');
  expect(line(loose.id), 'its words in a long value only').toContain('(named loosely by the text');
}, 180_000);

it('a stored name holding no word the parser keeps is reported, not searched for nothing', async () => {
  const id = randomUUID();
  await world.db.admin.execute(
    `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
    [world.alpha, id, 'x'.repeat(3000)],
  );
  const found = await findCopies(world.adminUrl, ['--id', id], 'alpha');
  expect(found.code).toBe(0);
  expect(pairs(found.hits)).toContainEqual(['people', id]);
  expect(found.stderr).toContain(`${id}'s stored name`);
}, 180_000);
