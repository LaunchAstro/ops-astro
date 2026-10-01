// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { raiseEscalation } from '../../packages/core-records/src/inbox/raise.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

it('every newly eligible business decider gets an escalation item', async () => {
  const businessId = '11111111-1111-4111-8111-111111111111';
  const gateId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const scoped = '44444444-4444-4444-8444-444444444444';
  const existing = '55555555-5555-4555-8555-555555555555';
  const recipient = '66666666-6666-4666-8666-666666666666';
  const otherNewDecider = '77777777-7777-4777-8777-777777777777';
  const items = new Map<string, 'open' | 'withdrawn'>([
    [scoped, 'open'],
    [existing, 'open'],
  ]);
  const businessDeciders = [existing, recipient, otherNewDecider];

  const tx: TenantQuery = {
    businessId,
    query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
      if (sql.includes('from public.gates g')) return Promise.resolve([{ taskId }] as Row[]);
      if (sql.includes('from effective e')) {
        return Promise.resolve(businessDeciders.map((person_id) => ({ person_id })) as Row[]);
      }
      if (sql.startsWith('update public.inbox_items')) {
        for (const person of items.keys()) {
          if (!businessDeciders.includes(person)) items.set(person, 'withdrawn');
        }
        return Promise.resolve([]);
      }
      if (sql.startsWith('insert into public.inbox_items')) {
        const person = String(parameters[1]);
        items.set(person, 'open');
        return Promise.resolve([{ id: '88888888-8888-4888-8888-888888888888' }] as Row[]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await raiseEscalation(tx, { gateId, recipientPersonId: recipient });

  expect(items.get(scoped)).toBe('withdrawn');
  for (const person of businessDeciders) expect(items.get(person)).toBe('open');
});
