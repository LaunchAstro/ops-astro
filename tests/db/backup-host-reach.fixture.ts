// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup store reached from the machine, for the store's policy suites
// (backup-identity.fixture.ts re-exports it): psql's part, over one session.

import postgres from 'postgres';

/**
 * The store reached from the machine, for the policy suites here. It runs the
 * same scripts the job and the drill send through psql on staging's network
 * (scripts/ops/backup-store-reach.mjs) over one session, and answers what
 * `psql -At` prints: each row's one value, a line each.
 */
export async function hostReach(
  url: string,
  script: string | Iterable<string> | AsyncIterable<string>,
  onLine?: (line: string) => unknown,
): Promise<string> {
  let text = '';
  if (typeof script === 'string') text = script;
  else for await (const piece of script) text += piece;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let printed: string;
  try {
    // A line with psql's `\bind 'v' ... \g` (backup-store-reach.mjs `bound`)
    // runs as psql runs it, in its place: its values as bound parameters.
    const rows: unknown[] = [];
    let pending = '';
    const flush = async (): Promise<void> => {
      if (pending.trim() !== '') rows.push(...[await sql.unsafe(pending)].flat(2));
      pending = '';
    };
    for (const line of text.split('\n')) {
      const bind = /^(.*) \\bind((?: '[^']*')*) \\g$/u.exec(line);
      if (bind === null) {
        pending += `${line}\n`;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, as psql sends them
      await flush();
      const values = [...(bind[2] ?? '').matchAll(/'([^']*)'/gu)].map(([, v]) => v ?? '');
      // oxlint-disable-next-line no-await-in-loop
      rows.push(...[await sql.unsafe(bind[1] ?? '', values)].flat(2));
    }
    await flush();
    printed = (rows as Record<string, unknown>[])
      .map((row) => String(Object.values(row)[0] ?? ''))
      .join('\n');
  } finally {
    await sql.end();
  }
  if (onLine === undefined) return printed;
  for (const line of printed === '' ? [] : printed.split('\n')) {
    // oxlint-disable-next-line no-await-in-loop -- a line at a time, as psql prints them
    await onLine(line);
  }
  return '';
}
