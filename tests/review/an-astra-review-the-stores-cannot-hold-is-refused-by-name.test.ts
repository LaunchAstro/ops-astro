// SPDX-License-Identifier: AGPL-3.0-only
//
// #2076: Astra's saved review lands in a text column, which refuses a NUL with a raise, and
// an unpaired surrogate would be stored as U+FFFD, not as sent. Either is refused at the door
// as `FIELD_VALUE_INVALID` naming `review`, never a fault, and no Astra review is stored.
// From Sol's proof on #2129 (S2129-1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Unstorable Astra review: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xnul');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('an Astra review the stores cannot hold', () => {
  it.each([
    ['a NUL', 'Astra\u0000approved'],
    ['an unpaired surrogate', 'Astra \uD800 approved'],
  ])('holding %s is refused by name and stores nothing', async (_name, review) => {
    const at = openedOf(detailOf(await w.open(w.fay)));
    const answer = await w
      .astra(w.ben, at, 'approve', w.world.business, { review })
      .catch((error: { code?: string }) => ({ thrownSqlState: error.code }));
    expect(answer).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID', names: ['review'] });
    const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.review_astra_reviews where review_id = $1',
      [at.reviewId],
    );
    expect(row?.n).toBe('0');
  });
});
