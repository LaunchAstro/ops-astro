// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging holds made-up data only (ticket S0-1), so the seed refuses a database
// it cannot vouch for, judged first from the database's own mark. An unmarked
// database is refused on that alone, reading no business's rows and no
// sign-in. The seed writes the mark, naming by digest the businesses and people
// it made; a marked database is then refused if it holds any other business or
// person, a record of a type the seed never installs, or a sign-in outside the
// seed's reserved `.local` addresses. A mark is always checked: a person's
// LOCAL_SEED_MADE_UP=confirm applies only to an unmarked database (a new one,
// or one seeded before the mark), and then holds it to the seed's keys, names
// and types instead. The questions are yes-or-no, so no refusal carries counts
// or record content.
import { createHash } from 'node:crypto';

/** The one call this needs from the owner connection. */
export interface OwnerQuery {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

const MARK = 'ops-astro made-up data; businesses: ';
const PEOPLE = '; people: ';
const SEED_TYPES = ['task', 'task_state', 'task_comment'];
const BY_DIGEST = "not (encode(sha256(id::text::bytea), 'hex') = any($1))";
const ids = (list: string): string[] => list.split(',').filter(Boolean);
const digest = (id: string): string => createHash('sha256').update(id).digest('hex');
const joined = (list: readonly string[]): string => list.map(digest).toSorted().join(',');

async function yes(admin: OwnerQuery, text: string, parameters: unknown[] = []): Promise<boolean> {
  const [row] = await admin.execute<{ yes: boolean }>(`select (${text}) as yes`, parameters);
  return row?.yes === true;
}

async function readMark(admin: OwnerQuery): Promise<[string[], string[]] | undefined> {
  const [row] = await admin.execute<{ mark: string | null }>(
    `select shobj_description(oid, 'pg_database') as mark
       from pg_database where datname = current_database()`,
  );
  const mark = row?.mark;
  if (typeof mark !== 'string' || !mark.startsWith(MARK) || !mark.includes(PEOPLE))
    return undefined;
  const [businesses = '', people = ''] = mark.slice(MARK.length).split(PEOPLE);
  return [ids(businesses), ids(people)];
}

export async function productionSigns(
  admin: OwnerQuery,
  madeUpBusinesses: readonly string[],
  confirmed = false,
  madeUpPeople: readonly string[] = [],
): Promise<string[]> {
  const mark = await readMark(admin);
  if (mark === undefined && !confirmed) return ['it carries no made-up mark'];
  const [businesses, people] = mark ?? [[...madeUpBusinesses], [...madeUpPeople]];
  const [business, person] = mark
    ? [BY_DIGEST, BY_DIGEST]
    : ['not (key = any($1))', 'not (display_name = any($1))'];
  const signs: string[] = [];
  if (await yes(admin, `exists (select from public.businesses where ${business})`, [businesses]))
    signs.push('it holds a business the seed did not make');
  if (await yes(admin, `exists (select from public.people where ${person})`, [people]))
    signs.push('it holds a person the seed did not make');
  const types = `exists (select from public.record_types t join public.records r
    on r.business_id = t.business_id and r.record_type_id = t.id where not (t.key = any($1)))`;
  if (await yes(admin, types, [SEED_TYPES]))
    signs.push('it holds a record the seed cannot vouch for');
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
