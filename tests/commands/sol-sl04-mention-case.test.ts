// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readMentions, type TenantQuery } from '../../packages/core-records/src/index.ts';

describe('INB-1 mentions', () => {
  it('Sol proof, criterion 21: a readable teammate named by an uppercase UUID is accepted', async () => {
    const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const task = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const tx: TenantQuery = {
      businessId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      query<Row>(sql: string): Promise<readonly Row[]> {
        if (sql.includes('from public.people p')) {
          return Promise.resolve([{ id: person, name: 'Ada Teammate', member: true }] as Row[]);
        }
        if (sql.includes('from public.records')) {
          return Promise.resolve([{ trashed: false, clientId: null }] as Row[]);
        }
        if (sql.includes('from public.actors')) return Promise.resolve([]);
        if (sql.includes('from effective e')) return Promise.resolve([{ id: 'grant-1' }] as Row[]);
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const [mention] = await readMentions(tx, { taskId: task, audience: 'internal' }, [
      person.toUpperCase(),
    ]);
    expect(mention).toMatchObject({ label: 'Ada Teammate', readable: true, member: true });
  });
});
