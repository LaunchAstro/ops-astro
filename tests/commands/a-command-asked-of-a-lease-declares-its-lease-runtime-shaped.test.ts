// SPDX-License-Identifier: AGPL-3.0-only
//
// A replay of a command asked of a lease is answered only while that lease is
// still the caller's, and `leaseLapsed` (`lease-replay.ts`) knows a lease
// command only by its declaration's `runtimeShaped: 'leaseId'` (#2332). A new
// lease command that left the field out would replay its stored success after
// its lease lapsed, and no replay test names a command that does not exist yet
// (#2353). So every `authorisedOn: 'claim'` row that takes a `leaseId` must
// declare it. `command-catalogue-pin.test.ts` pins the rows that declare a
// runtime-shaped field, so it cannot see a row that declares none.

import { describe, expect, it } from 'vitest';
import type { CommandDeclaration } from '../../packages/core-wire/src/surface-declaration.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';

/** Whether the row takes a `leaseId`, as an identifier it admits or as an operand. */
const takesALease = (row: CommandDeclaration): boolean =>
  (row.untargetedIdentifiers ?? []).includes('leaseId') ||
  Object.keys(row.operands ?? {}).includes('leaseId');

const leaseRows = COMMAND_SURFACE.filter((row) => takesALease(row));
const claimLeaseRows = leaseRows.filter((row) => row.authorisedOn === 'claim');

describe('a command asked of a lease', () => {
  it('finds the lease commands, the review claim and land among them, so an empty scan cannot pass', () => {
    expect(claimLeaseRows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['review.capture_claim', 'review.capture_land', 'task.check']),
    );
  });

  it("declares runtimeShaped 'leaseId' on every claim-authorised row that takes a leaseId", () => {
    expect(
      Object.fromEntries(claimLeaseRows.map((row) => [row.name, row.runtimeShaped])),
    ).toStrictEqual(Object.fromEntries(claimLeaseRows.map((row) => [row.name, 'leaseId'])));
  });

  it('is authorised on its claim wherever it takes a leaseId, so no row steps outside that check', () => {
    expect(
      leaseRows.filter((row) => row.authorisedOn !== 'claim').map((row) => row.name),
    ).toStrictEqual([]);
  });
});
