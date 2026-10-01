// From SL12's take interim review: SL11/SL12's column-grant contract
// (restricted-calls-cases.ts) auto-merged beside batch 1's migrations 0046 and
// 0047, which make column grants of their own (the lookup identity's
// SELECT (id, key) on businesses, the outbox's INSERT of four columns).
// The contract does not name them, so the full-schema restricted-calls case
// 'grants update column by column only as the contract says' is red.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  APPLICATION_ROLE,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  catalogueColumnGrants,
  columnUpdatesAt,
  roleColumnGrantsAt,
} from '../tenancy/restricted-calls-cases.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('SL12 take: column grants', () => {
  let db: FreshDatabase;
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'solproof' });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  it("the column-grant contract names batch 1's column grants", async () => {
    const held = await catalogueColumnGrants(db.admin);
    // oxlint-disable-next-line unicorn/prefer-set-has -- the reviewer's proof, kept as written
    const wanted = [
      ...columnUpdatesAt().map((pair) => `${APPLICATION_ROLE} UPDATE ${pair}`),
      ...roleColumnGrantsAt(),
    ];
    expect(held.filter((line) => !wanted.includes(line))).toStrictEqual([]);
  });
});
