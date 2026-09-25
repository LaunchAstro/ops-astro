// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-JSONB, R2-THERMO-22: the timestamptz value check against the column's
// own limits, without a database. Each boundary below was measured against
// the lane's Postgres 18.6 container with `select '<value>'::timestamptz`
// (FR2-JSONB handback): the refused ones raised there, the accepted ones did
// not. The database-bound half is `tests/runtime/final-r2-fr2-jsonb.test.ts`.

import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../../packages/core-records/src/records/fields.ts';
import { refuseWrongValueType } from '../../packages/core-records/src/commands/values.ts';

const DUE = {
  key: 'due',
  valueType: 'timestamptz',
  deactivatedAt: null,
} as unknown as FieldDefinition;

const refusal = (due: string) => refuseWrongValueType([DUE], { due });

describe('timestamptz values, as the column takes them', () => {
  it.each([
    '2026-02-30',
    '2026-09-31',
    '2026-02-29',
    '1900-02-29',
    '0000-01-01',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-01T24:00:01',
    '2026-01-01T24:30',
    '2026-01-01T25:00',
    '2026-01-01T23:60',
    '2026-01-01T23:59:61',
    // Postgres takes a leap second; the check keeps refusing it, as at 3eb0cc1.
    '2026-01-01T23:59:60',
    '2026-01-01T00:00+16:00',
    '2026-01-01T00:00-16:00',
    '2026-01-01T00:00+15:60',
    '2026-01-01T00:00+00:99',
    '1',
    '2026-1-01',
  ])('%s is refused FIELD_VALUE_INVALID naming due=timestamptz', (due) => {
    expect(refusal(due)).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['due=timestamptz'] });
  });

  it.each([
    '2028-02-29',
    '2000-02-29',
    '0001-01-01',
    '2026-12-31T23:59:59.999999Z',
    '2026-01-01T24:00',
    '2026-01-01T24:00:00',
    '2026-01-01T00:00+15:59',
    '2026-01-01T00:00-15:59',
    '2026-01-01T00:00+1559',
    '2026-01-01 08:30',
  ])('%s is taken', (due) => {
    expect(refusal(due)).toBeUndefined();
  });
});
