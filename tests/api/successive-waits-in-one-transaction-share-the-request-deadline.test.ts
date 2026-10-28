// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2243-2 (#2240). One transaction of the pass waits on the
// budget cap's row, then on the task envelope's: a limit that each lock wait
// gets afresh, as `lock_timeout` was, lets the second wait run past the pass
// deadline. One deadline for the whole pass holds both waits to it.
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { boundWorld, request, sleep, withinBound } from './recovery-pass-bound-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the hosted request bound', () => {
  it('Sol proof, criterion 2: successive waits in one transaction share the request deadline', async () => {
    const world = await boundWorld('sol2243successive');
    const { s } = world;
    try {
      const cap = world.holder();
      const envelope = world.holder();
      await cap.query('begin');
      await cap.query(
        'select 1 from public.budget_caps where business_id = $1 and id = $2 for update',
        [s.business, s.capId],
      );
      await envelope.query('begin');
      await envelope.query(
        'select 1 from public.task_envelopes where business_id = $1 for update',
        [s.business],
      );
      const started = performance.now();
      const answer = withinBound(world.handle(request('/api/health')), started);
      await expect.poll(async () => await world.waiting('%budget_caps%')).toBeDefined();
      await sleep(1_500);
      await cap.query('rollback');
      await expect.poll(async () => await world.waiting('%task_envelopes%')).toBeDefined();
      const result = await answer;
      console.log('successive waits:', result, Math.round(performance.now() - started), 'ms');
      expect(result, 'successive lock waits in one transaction share the pass deadline').not.toBe(
        'held',
      );
    } finally {
      await world.end();
    }
  }, 30_000);
});
