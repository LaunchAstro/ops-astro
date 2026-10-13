// SPDX-License-Identifier: AGPL-3.0-only
//
// An attempt id is a UUID, and a UUID in capitals is the same UUID. The
// receipt read accepts either spelling, and the effect identity it looks up
// (`effect:<attempt>`) is the one the register stores, which is lowercase. Read
// with the capitals kept, the receipt of an observed effect was not found.

import { describe, expect, it } from 'vitest';
import { parseReceipt, serveReceipt } from '../../packages/core-commands/src/reads/receipts.ts';
import type { Session, TenantQuery } from '../../packages/core-records/src/index.ts';

const lower = '3f2b8c1a-9d4e-4f6a-8b7c-1e2d3c4b5a69';

/** The parameters each statement of one read was sent with. */
async function lookedUp(attemptId: string): Promise<readonly unknown[]> {
  const parsed = parseReceipt({ attemptId });
  if (!parsed.ok) throw new Error('refused');
  const sent: unknown[] = [];
  const tx = {
    businessId: 'b',
    query: (_sql: string, parameters: readonly unknown[] = []) => {
      sent.push(...parameters);
      return Promise.resolve([]);
    },
  } as unknown as TenantQuery;
  const session = { roleKey: 'owner' } as Session;
  await serveReceipt(tx, session, parsed.operands, { recordId: 't' });
  return sent;
}

describe('the receipt read', () => {
  it('looks up the same attempt and effect identity whichever case the attempt id is sent in', async () => {
    const asked = await lookedUp(lower.toUpperCase());
    expect(asked).toStrictEqual(await lookedUp(lower));
    expect(asked).toContain(`effect:${lower}`);
  });
});
