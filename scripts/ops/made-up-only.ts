// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging holds made-up data only (ticket S0-1), so the seed refuses a database
// that shows what a restored production backup brings: a business the seed
// does not make, or a sign-in address that is not a made-up one. The seed's
// addresses all end `.local`, a name reserved for local networks, so no real
// person's address can end that way.
//
// It returns the signs it found as counts, never the rows: a business's name or
// a person's address in a refusal would be record content in a log, the thing
// the refusal exists to keep out of staging.

/** The one call this needs from the owner connection. */
export interface OwnerQuery {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

const MADE_UP_ADDRESS = '%.local';

export async function productionSigns(
  admin: OwnerQuery,
  madeUpBusinesses: readonly string[],
): Promise<string[]> {
  const signs: string[] = [];
  const [businesses] = await admin.execute<{ n: number }>(
    'select count(*)::int as n from public.businesses where not (key = any($1::text[]))',
    [madeUpBusinesses],
  );
  const strangers = businesses?.n ?? 0;
  if (strangers > 0)
    signs.push(`${strangers} business${strangers === 1 ? '' : 'es'} the seed does not make`);

  const [auth] = await admin.execute<{ present: boolean }>(
    "select to_regclass('auth.users') is not null as present",
  );
  if (auth?.present === true) {
    const [addresses] = await admin.execute<{ n: number }>(
      'select count(*)::int as n from auth.users where email is not null and email not like $1',
      [MADE_UP_ADDRESS],
    );
    const real = addresses?.n ?? 0;
    if (real > 0)
      signs.push(
        `${real} sign-in address${real === 1 ? '' : 'es'} that ${real === 1 ? 'is' : 'are'} not a made-up one`,
      );
  }
  return signs;
}
