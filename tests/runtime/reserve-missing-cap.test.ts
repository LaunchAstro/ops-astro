// SPDX-License-Identifier: AGPL-3.0-only
//
// Thermo O2, lead ruling: `reserve` fails closed on a missing cap, with the
// code preflight already answers (`BUDGET_UNAVAILABLE`), instead of reserving
// against a ceiling it could not read.
//
// Through a real database the case cannot arise: `task_envelopes_cap_fkey`
// holds the cap, the app role cannot delete one, and the cap's policies admit
// every row of the business the envelope was read in. So the transaction here
// is scripted: it answers the envelope read, answers the cap read with no row,
// and records every other statement, so a reservation written past the missing
// cap is visible as a statement that should never have been sent.

import { describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { reserve } from '../../packages/core-runtime/src/decide.ts';

const BUSINESS = '00000000-0000-4000-8000-00000000000b';
const ENVELOPE = '00000000-0000-4000-8000-00000000000e';
const CAP = '00000000-0000-4000-8000-00000000000c';

function scripted(): { readonly tx: TenantQuery; readonly writes: string[] } {
  const writes: string[] = [];
  const tx: TenantQuery = {
    businessId: BUSINESS,
    query<Row>(text: string): Promise<readonly Row[]> {
      if (text.includes('from public.task_envelopes where business_id = $1 and id = $2')) {
        const envelope = {
          cap_id: CAP,
          maximum_minor: '1000',
          held_minor: '0',
          actual_minor: '0',
        };
        return Promise.resolve([envelope as Row]);
      }
      if (text.includes('from public.budget_caps c')) return Promise.resolve([]);
      writes.push(text.trim().split(/\s+/u).slice(0, 3).join(' '));
      return Promise.resolve([]);
    },
  };
  return { tx, writes };
}

describe('reserve against a cap it cannot read (thermo O2)', () => {
  it('refuses BUDGET_UNAVAILABLE and writes nothing', async () => {
    const { tx, writes } = scripted();
    const result = await reserve(tx, {
      envelopeId: ENVELOPE,
      versionId: '00000000-0000-4000-8000-000000000001',
      runId: '00000000-0000-4000-8000-000000000002',
      stepId: 'step-1',
      heldMinor: 100,
    });
    expect(result).toStrictEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: 'BUDGET_UNAVAILABLE',
        reason: `no budget cap ${CAP} in this business`,
      }),
    });
    expect(writes).toStrictEqual([]);
  });
});
