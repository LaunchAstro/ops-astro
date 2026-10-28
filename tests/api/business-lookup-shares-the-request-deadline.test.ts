// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's design check on #2243 (#2240): the pass reads each business key in a
// lookup transaction of its own on the lookup login, before any phase. A
// deadline set only on the phases leaves that read waiting as long as
// `public.businesses` is held. The pass deadline covers it too, and the
// lookup's transaction has ended by the answer.
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { boundWorld, request, withinBound } from './recovery-pass-bound-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the hosted request bound', () => {
  it('Sol proof, criterion 2: business lookup shares the request deadline', async () => {
    const world = await boundWorld('sol2243lookup');
    try {
      const holder = world.holder();
      await holder.query('begin');
      await holder.query('lock table public.businesses in access exclusive mode');
      const started = performance.now();
      const answer = withinBound(world.handle(request('/api/health')), started);
      await expect
        .poll(async () => await world.waiting('%public.businesses%', world.lookupLogin))
        .toBeDefined();
      const result = await answer;
      console.log('business lookup:', result, Math.round(performance.now() - started), 'ms');
      expect(result, 'the business-key lookup shares the pass deadline').toBe(200);
      expect(await world.open(world.lookupLogin), 'the lookup is still in its transaction').toBe(0);
      expect(await world.open(), 'the pass is still in a transaction').toBe(0);
    } finally {
      await world.end();
    }
  }, 30_000);
});
