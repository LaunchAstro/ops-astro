// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2016, D2122-1): a decision is a person's alone. The door already keeps every agent
// credential off `review.decide_change` (person-only, `CREDENTIAL_REACH` in
// `credential-envelope.ts`); the handler refuses a credential-scoped session itself too, as
// `task.launch` does, before it reads or writes anything.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decideChange } from '../../packages/core-commands/src/commands/review-change.ts';

describe('C57 a decision on an agent key', () => {
  it('is refused before any read, and decides nothing', async () => {
    const statements: string[] = [];
    const tx = {
      businessId: randomUUID(),
      query: async (sql: string) => {
        statements.push(sql);
        return [];
      },
    };
    const session = {
      actorId: randomUUID(),
      personId: randomUUID(),
      roleKey: 'admin',
      credentialScope: [{ collection: 'proposal', action: 'decide' }],
    };
    const outcome = await decideChange(tx as never, { session } as never, {
      command: 'review.decide_change',
      operationId: randomUUID(),
      changeRequestId: randomUUID(),
      decision: 'approve',
    });
    expect('refusal' in outcome ? outcome.refusal.code : 'applied').toBe('SCOPE_NOT_GRANTED');
    expect(statements).toStrictEqual([]);
  });
});
