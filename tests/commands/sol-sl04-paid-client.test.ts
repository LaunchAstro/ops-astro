// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { raiseMentions, type TenantQuery } from '../../packages/core-records/src/index.ts';

describe('INB-1 client comment', () => {
  it('Sol proof, criterion 32: a paid outside client named in a client-visible comment receives an item', async () => {
    const recipient = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const raised: { reason: unknown; recipient: unknown }[] = [];
    const tx: TenantQuery = {
      businessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
        if (sql.includes('from public.actors')) {
          return Promise.resolve([{ person_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] as Row[]);
        }
        if (sql.includes('insert into public.inbox_items')) {
          raised.push({ recipient: parameters[1], reason: parameters[3] });
          return Promise.resolve([{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] as Row[]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const comment = {
      taskId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      commentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      authorActorId: '11111111-1111-4111-8111-111111111111',
      audience: 'client',
    };
    const named = [
      {
        personId: recipient,
        label: 'Paid client',
        readable: true,
        member: false,
        paidClient: true,
      },
    ];

    await raiseMentions(tx, comment, named);
    expect(raised).toStrictEqual([{ recipient, reason: 'client_comment' }]);
  });
});
