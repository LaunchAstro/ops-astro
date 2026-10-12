// SPDX-License-Identifier: AGPL-3.0-only
//
// `canonicalUniqueValue` promises the form the unique-value store claims a
// value under, which is the schema's `lower(btrim(value))`. `btrim` with one
// argument removes ordinary spaces and nothing else, so a value padded with a
// tab or a newline keeps that padding in the store and must keep it here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalUniqueValue } from '../../packages/core-records/src/records/fields.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';

const PADDED = ['  Ada@Example.COM ', '\tAda@Example.COM\n', ' \n Ada@Example.COM\t '];

describe('the canonical unique value', () => {
  it('keeps tab and newline padding, which the store does not trim', () => {
    expect(canonicalUniqueValue('\tAda@Example.COM\n')).toBe('\tada@example.com\n');
  });

  it('still trims ordinary spaces and lower-cases', () => {
    expect(canonicalUniqueValue('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the canonical unique value against the store', () => {
  let db: EmptyDatabase;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'd' });
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  it.each(PADDED)('equals the store’s lower(btrim()) for %j', async (input) => {
    const rows = await db.admin.execute<{ readonly stored: string }>(
      'select lower(btrim($1)) as stored',
      [input],
    );
    expect(canonicalUniqueValue(input)).toBe(rows[0]?.stored);
  });
});
