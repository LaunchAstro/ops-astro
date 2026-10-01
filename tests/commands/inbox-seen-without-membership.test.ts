// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { prepareCommand } from '../../packages/core-commands/src/commands/prepare.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import {
  NO_ASSURANCE,
  type TenantQuery,
  type Session,
} from '../../packages/core-records/src/index.ts';

describe('INB-1 recipient attention', () => {
  it('a shared-task recipient without membership can open their own item', async () => {
    const businessId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const session: Session = {
      businessId,
      loginId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      roleKey: null,
      assurance: NO_ASSURANCE,
    };
    const tx: TenantQuery = {
      businessId,
      query<Row>(sql: string): Promise<readonly Row[]> {
        if (sql.includes('from public.field_defs')) return Promise.resolve([]);
        if (sql.includes('from record_types')) {
          return Promise.resolve([
            { key: 'task', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
            { key: 'task_state', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
          ] as Row[]);
        }
        if (sql.includes('from records')) return Promise.resolve([]);
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const declaration = declarationOf('inbox.seen');
    const prepared = await prepareCommand(
      tx,
      session,
      'api',
      {
        command: 'inbox.seen',
        operationId: 'sol-external-seen',
        itemId: '11111111-1111-4111-8111-111111111111',
      },
      declaration,
    );
    expect(prepared).not.toHaveProperty('refusal');
    expect(prepared).toHaveProperty('request.command', 'inbox.seen');
  });
});
