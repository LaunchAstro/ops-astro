// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging holds made-up data only (ticket S0-1), so the seed refuses a database
// it cannot vouch for. It judges provenance, not content: a database the seed
// found empty is marked with the businesses the seed made there, and a later
// run accepts that database only while it holds no business beyond them. A
// restored production backup is either unmarked or brings businesses the mark
// does not name, whatever keys, people or records it carries.
//
// It asks the database yes-or-no questions only. It counts no business's rows
// and reads no person's, so its refusal carries no record content. Sign-ins are
// the one table outside a business: the seed's addresses all end `.local`, a
// name reserved for local networks, so any other sign-in (a phone one included)
// is one the seed never made.
//
// A database seeded before the mark existed carries none. A person who knows it
// holds made-up data only confirms that once with LOCAL_SEED_MADE_UP=confirm,
// and the seed then marks it.

/** The one call this needs from the owner connection. */
export interface OwnerQuery {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

const MARK = 'ops-astro made-up data, seeded businesses: ';

async function yes(admin: OwnerQuery, text: string, parameters: unknown[] = []): Promise<boolean> {
  const [row] = await admin.execute<{ yes: boolean }>(`select (${text}) as yes`, parameters);
  return row?.yes === true;
}

async function markedBusinesses(admin: OwnerQuery): Promise<string[] | undefined> {
  const [row] = await admin.execute<{ mark: string | null }>(
    `select shobj_description(oid, 'pg_database') as mark
       from pg_database where datname = current_database()`,
  );
  const mark = row?.mark;
  return typeof mark === 'string' && mark.startsWith(MARK)
    ? mark.slice(MARK.length).split(',').filter(Boolean)
    : undefined;
}

export async function productionSigns(
  admin: OwnerQuery,
  madeUpBusinesses: readonly string[],
  confirmed = false,
): Promise<string[]> {
  const signs: string[] = [];
  const marked = await markedBusinesses(admin);
  if (marked !== undefined) {
    if (
      await yes(admin, 'exists (select from public.businesses where not (id::text = any($1)))', [
        marked,
      ])
    )
      signs.push('it holds a business the seed did not make here');
  } else if (confirmed) {
    if (
      await yes(admin, 'exists (select from public.businesses where not (key = any($1)))', [
        [...madeUpBusinesses],
      ])
    )
      signs.push('it holds a business the seed does not make');
  } else if (await yes(admin, 'exists (select from public.businesses)')) {
    signs.push('it holds businesses and carries no made-up mark');
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

/** Mark the database with the businesses the seed made in it. */
export async function markMadeUp(admin: OwnerQuery, businessIds: readonly string[]): Promise<void> {
  const [row] = await admin.execute<{ statement: string }>(
    "select format('comment on database %I is %L', current_database(), $1::text) as statement",
    [`${MARK}${[...businessIds].toSorted().join(',')}`],
  );
  if (row === undefined) throw new Error('made-up-only: no mark statement');
  await admin.execute(row.statement);
}
