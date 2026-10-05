// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's address check (operator.ts, D1 security review R2): a
// setting names one host, and a database address names exactly the one host
// postgres.js reads from it. postgres.js decodes the authority before it
// splits a host list and cuts it at the first `@`, where URL cuts at the
// last, so an encoded comma, or an `@` and a comma inside the password, make
// a list URL never shows, pieces of the password among its hosts.

import postgres from 'postgres';

/**
 * Whether the setting `name` holds one host with no comma; for a `DATABASE_`
 * setting, also exactly the one host postgres.js would read. Nothing connects
 * until a query, and an address it cannot read throws an error never shown.
 */
export function oneHost(name: string, value = ''): boolean {
  const hostname = URL.parse(value)?.hostname ?? '';
  if (!/^[^,]+$/u.test(hostname)) return false;
  if (!name.startsWith('DATABASE_')) return true;
  try {
    const read = postgres(value).options.host;
    return read.length === 1 && read[0] === hostname;
  } catch {
    return false;
  }
}
