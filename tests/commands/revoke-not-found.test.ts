// SPDX-License-Identifier: AGPL-3.0-only
//
// `grant.revoke` and `delegation.revoke` answer a grant or a delegation that
// is not there with the one `NOT_FOUND` the rest of the surface gives
// (`refuseNotFound` in `commands/refusal.ts`), both fix lines of it, not a
// truncated copy (THERMO-RECHECK-3 R3C2, as M5 was for the lineage controls).
//
// The transaction is a stub that answers "no row", so this is a pure unit
// suite and must not be named in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import {
  revokeDelegationAsManager,
  revokeGrantAsManager,
} from '../../packages/core-records/src/commands/authority-controls.ts';
import {
  isRefused,
  type HandlerOutcome,
} from '../../packages/core-records/src/commands/outcome.ts';
import { refuseNotFound } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandContext } from '../../packages/core-records/src/commands/context.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/** A transaction that holds no grant and no delegation. */
const empty = {
  businessId: '3f1d2f3a-0000-4000-8000-0000000000b1',
  query: async () => await Promise.resolve([]),
} as unknown as TenantQuery;

const context = {} as unknown as CommandContext;

function refusalOf(outcome: HandlerOutcome) {
  if (!isRefused(outcome)) throw new Error('expected a refusal');
  return outcome.refusal;
}

const cases = [
  { what: 'a malformed identifier', id: 'nope' },
  { what: 'an identifier that is not there', id: '3f1d2f3a-0000-4000-8000-000000000001' },
] as const;

describe('the revokes answer NOT_FOUND in the surface words', () => {
  it.each(cases)('grant.revoke: $what', async ({ id }) => {
    const refusal = refusalOf(await revokeGrantAsManager(empty, context, id));
    expect(refusal).toStrictEqual(refuseNotFound());
  });

  it.each(cases)('delegation.revoke: $what', async ({ id }) => {
    const refusal = refusalOf(await revokeDelegationAsManager(empty, context, id));
    expect(refusal).toStrictEqual(refuseNotFound());
  });
});
