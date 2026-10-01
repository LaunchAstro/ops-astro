// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-30 MONEY in the schema (`0219_reservation_stop_cause`): a hold the
// classifier settles `actual` at its calls' spend records the cause that
// stopped it, as an abandoned hold does (T5, cause recorded). The check that
// kept every cause off an `actual` row now admits one there, and nowhere else
// new: an abandoned hold still needs its cause, and a held or quarantined one
// still cannot carry one.
//
// Each write goes straight through the application role, with no code path in
// front of it, in a transaction that always rolls back.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const CHECK = /reservations_abandoned_has_cause/u;
/** Thrown to end a transaction whose write was accepted, so the world keeps no trace of it. */
const ACCEPTED = new Error('accepted, rolled back');
const CAUSE = `classified_cause = 'lease_expired_and_fenced', classified_cause_id = $2`;

type Answer = 'accepted' | { readonly code: string; readonly message: string };

// eslint-disable-next-line max-lines-per-function -- three cases over one world
describe.skipIf(serverUrl === undefined)('a stopped hold records why it stopped', () => {
  let s: Schedules;
  let reservationId: string;

  beforeAll(async () => {
    s = await openSchedules('stop_cause', 1_000_000);
    const work = await liveWork(s, `stop cause ${randomUUID()}`, 2_000);
    reservationId = String(work.decision['reservationId']);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** `set` written on the held reservation as the application role, always rolled back. */
  const writeAsApp = async (set: string): Promise<Answer> => {
    try {
      await s.db.admin.transaction(async (execute) => {
        await execute('set local role ops_astro_app');
        await execute(`select set_config('app.business_id', $1, true)`, [s.business]);
        const update = `update public.reservations set ${set} where id = $1 and state = 'held'`;
        await execute(update, set.includes('$2') ? [reservationId, randomUUID()] : [reservationId]);
        throw ACCEPTED;
      });
    } catch (error) {
      if (error === ACCEPTED) return 'accepted';
      return { code: String((error as { code?: unknown }).code), message: String(error) };
    }
    throw new Error('the transaction neither threw nor rolled back');
  };

  const refused = { code: '23514', message: expect.stringMatching(CHECK) };

  it('an actual reservation may carry the cause that stopped it', async () => {
    const settled = `state = 'actual', actual_minor = 1, terminal_at = now()`;
    expect(await writeAsApp(`${settled}, ${CAUSE}`)).toBe('accepted');
    // Control: a settle at an observed outcome still records no cause.
    expect(await writeAsApp(settled)).toBe('accepted');
  });

  it('a held reservation still cannot carry a classified cause', async () => {
    expect(await writeAsApp(CAUSE)).toMatchObject(refused);
    expect(await writeAsApp(`state = 'quarantined', ${CAUSE}`)).toMatchObject(refused);
    // Control: quarantined with no cause is a write the check accepts.
    expect(await writeAsApp(`state = 'quarantined'`)).toBe('accepted');
  });

  it('an abandoned reservation still needs one', async () => {
    const abandoned = `state = 'abandoned', terminal_at = now()`;
    expect(await writeAsApp(abandoned)).toMatchObject(refused);
    // Control: the same abandonment with its cause.
    expect(await writeAsApp(`${abandoned}, ${CAUSE}`)).toBe('accepted');
  });
});
