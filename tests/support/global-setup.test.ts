// SPDX-License-Identifier: AGPL-3.0-only
//
// The global setup works through a database beside the configured one, so
// `scripts/db-conformance.mjs`, which reads the configured database's counter
// around each suite, never counts the setup's warm-up as the suite's own.

import { describe, expect, it } from 'vitest';

import { besideUrl } from './global-setup.ts';

const database = (url: string): string => new URL(url).pathname;

describe('the database the global setup connects to', () => {
  it('is postgres when the configured database is another one', () => {
    expect(database(besideUrl('postgres://owner:pw@127.0.0.1:5432/conformance'))).toBe('/postgres');
  });

  it('is template1 when the configured database is postgres', () => {
    expect(database(besideUrl('postgres://owner:pw@127.0.0.1:5432/postgres'))).toBe('/template1');
  });

  it('reads a URL without a database as the user-named one', () => {
    expect(database(besideUrl('postgres://postgres:pw@127.0.0.1:5432'))).toBe('/template1');
    expect(database(besideUrl('postgres://owner:pw@127.0.0.1:5432'))).toBe('/postgres');
  });

  it('keeps the server, the credentials and the parameters', () => {
    const beside = new URL(besideUrl('postgres://owner:p%2Fss@127.0.0.2:6543/app?sslmode=disable'));
    expect([beside.username, beside.password, beside.host, beside.search]).toEqual([
      'owner',
      'p%2Fss',
      '127.0.0.2:6543',
      '?sslmode=disable',
    ]);
  });
});
