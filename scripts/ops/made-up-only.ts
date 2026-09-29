// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging holds made-up data only (ticket S0-1), so the seed refuses a database
// it cannot vouch for. It judges provenance: a seeded database carries a mark
// naming, by digest, the businesses and people the seed made, and a run accepts
// it only while it holds no other business or person. It asks yes-or-no questions
// only, so a refusal carries no counts and no record content. Sign-ins sit
// outside any business: the seed's addresses all end `.local`, so any other
// sign-in, a phone one included, is one the seed never made.
//
// A database seeded before the mark is confirmed once by a person with
// LOCAL_SEED_MADE_UP=confirm: every business must then carry a seed key and
// every person a seed name, and the seed marks it.

import { createHash } from 'node:crypto';

/** The one call this needs from the owner connection. */
export interface OwnerQuery {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

const MARK = 'ops-astro made-up data; businesses: ';
const PEOPLE = '; people: ';
const ids = (list: string): string[] => list.split(',').filter(Boolean);
const UNMARKED = "not (encode(sha256(id::text::bytea), 'hex') = any($1))";
const digest = (id: string): string => createHash('sha256').update(id).digest('hex');
const joined = (list: readonly string[]): string => list.map(digest).toSorted().join(',');

async function yes(admin: OwnerQuery, text: string, parameters: unknown[] = []): Promise<boolean> {
  const [row] = await admin.execute<{ yes: boolean }>(`select (${text}) as yes`, parameters);
  return row?.yes === true;
}

async function readMark(
  admin: OwnerQuery,
): Promise<{ businesses: string[]; people: string[] } | undefined> {
  const [row] = await admin.execute<{ mark: string | null }>(
    `select shobj_description(oid, 'pg_database') as mark
       from pg_database where datname = current_database()`,
  );
  const mark = row?.mark;
  if (typeof mark !== 'string' || !mark.startsWith(MARK) || !mark.includes(PEOPLE))
    return undefined;
  const [businesses = '', people = ''] = mark.slice(MARK.length).split(PEOPLE);
  return { businesses: ids(businesses), people: ids(people) };
}

export async function productionSigns(
  admin: OwnerQuery,
  madeUpBusinesses: readonly string[],
  confirmed = false,
  madeUpPeople: readonly string[] = [],
): Promise<string[]> {
  const signs: string[] = [];
  const mark = confirmed ? undefined : await readMark(admin);
  const [business, person] = confirmed
    ? ['not (key = any($1))', 'not (display_name = any($1))']
    : [UNMARKED, UNMARKED];
  const [businesses, people] = confirmed
    ? [[...madeUpBusinesses], [...madeUpPeople]]
    : [mark?.businesses ?? [], mark?.people ?? []];
  if (!confirmed && mark === undefined) {
    if (await yes(admin, 'exists (select from public.businesses)'))
      signs.push('it holds businesses and carries no made-up mark');
  } else {
    if (await yes(admin, `exists (select from public.businesses where ${business})`, [businesses]))
      signs.push('it holds a business the seed did not make');
    if (await yes(admin, `exists (select from public.people where ${person})`, [people]))
      signs.push('it holds a person the seed did not make');
  }
  if (
    (await yes(admin, "to_regclass('auth.users') is not null")) &&
    (await yes(
      admin,
      "exists (select from auth.users where email is null or email not like '%.local')",
    ))
  )
    signs.push('it holds a sign-in that is not a made-up address');
  return signs;
}

/** Mark the database with the businesses and people the seed made in it. */
export async function markMadeUp(
  admin: OwnerQuery,
  businessIds: readonly string[],
  personIds: readonly string[] = [],
): Promise<void> {
  const [row] = await admin.execute<{ statement: string }>(
    "select format('comment on database %I is %L', current_database(), $1::text) as statement",
    [`${MARK}${joined(businessIds)}${PEOPLE}${joined(personIds)}`],
  );
  if (row === undefined) throw new Error('made-up-only: no mark statement');
  await admin.execute(row.statement);
}
