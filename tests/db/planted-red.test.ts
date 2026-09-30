// SPDX-License-Identifier: AGPL-3.0-only
// Planted red for the shard proof: reaches the database, then fails. Removed
// in the next commit.
import postgres from 'postgres';
import { expect, it } from 'vitest';

it.skipIf((process.env['DATABASE_URL'] ?? '') === '')(
  'planted red fails in its shard',
  async () => {
    const sql = postgres(process.env['DATABASE_URL'] ?? '', { max: 1, onnotice: () => undefined });
    try {
      const rows = await sql`select 1 as one`;
      expect(rows[0]?.['one']).toBe(2);
    } finally {
      await sql.end();
    }
  },
);
