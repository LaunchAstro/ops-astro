// SPDX-License-Identifier: AGPL-3.0-only
//
// R5 (#1689): single-operator mode against a second operator and the lock
// waits. Beta's one operator (eve) has made the business's first single-operator
// approval, on Astra's review, before these run, so each refusal here is the
// mode's or the grant's, never the review's. A second operator added on a
// separate connection while a decision waits on the mode's row is seen after the
// wait; so is a grant that expired during it.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { insertMembership, insertPerson } from '../identity/fixture.ts';
import type { C80World } from './c80-world.ts';
import {
  asEve,
  decide,
  eveRequests,
  heldInBeta,
  modeIn,
  recordReview,
  rowOf,
  setMode,
  SETTING_WAIT,
  soloWorld,
  waitedFor,
  type Asked,
} from './single-operator-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Single-operator second operator: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
let first: Asked;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await soloWorld('solo2');
  // The first approval, on its review. The setup asserts nothing, so no case is skipped; the
  // last case reads its mark.
  await setMode(w, w.beta, w.eve, true);
  first = await eveRequests(w);
  await recordReview(w, first.id, first.digest);
  await decide(w, first);
});

describe.skipIf(serverUrl === undefined)('a second operator and the lock waits', () => {
  it('refuses a self-approval once a grant expired during the decision’s lock wait', async () => {
    const own = await eveRequests(w);
    const holding = heldInBeta(w, async (tx) => {
      await tx.query(
        `select 1 from public.business_settings
          where business_id = $1 and key = 'single_operator_mode' for update`,
        [tx.businessId],
      );
    });
    await holding.ready;
    await w.world.db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '1 second'
        where business_id = $1 and subject_id = $2 and collection = 'gate' and action = 'decide'`,
      [w.beta, w.eve.personId],
    );
    try {
      const deciding = decide(w, own);
      const waited = await waitedFor(w, SETTING_WAIT);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_500);
      });
      holding.release();
      await holding.done;
      // The gate grant judged after the wait covers nothing: the correction is not one she sees.
      expect(codeOf(await deciding)).toBe('NOT_FOUND');
      expect(waited).toBe(true);
      expect(await rowOf(w, own.id)).toMatchObject({ state: 'requested' });
    } finally {
      holding.release();
      await w.world.db.admin.execute(
        `update public.grants set expires_at = null
          where business_id = $1 and subject_id = $2 and collection = 'gate' and action = 'decide'`,
        [w.beta, w.eve.personId],
      );
    }
  });
});

describe.skipIf(serverUrl === undefined)(
  'a second operator added during a decision’s lock wait',
  () => {
    it('sees a second operator added during the decision’s lock wait, and writes nothing', async () => {
      const own = await eveRequests(w);
      let offInside: unknown;
      const adding = heldInBeta(w, async (tx) => {
        const person = await insertPerson(tx, 'fay');
        await insertMembership(tx, person);
        const [row] = await tx.query<{ readonly value: unknown }>(
          `select value from public.business_settings
          where business_id = $1 and key = 'single_operator_mode'`,
          [tx.businessId],
        );
        offInside = row?.value;
      });
      await adding.ready;
      const deciding = decide(w, own);
      const waited = await waitedFor(w, SETTING_WAIT);
      adding.release();
      await adding.done;
      expect(codeOf(await deciding)).toBe('SELF_APPROVAL_REFUSED');
      expect(waited).toBe(true);
      expect(offInside).toBe(false);
      expect(await rowOf(w, own.id)).toMatchObject({
        state: 'requested',
        decided_by_person_id: null,
      });
      expect(await modeIn(w, w.beta)).toBe(false);
    });
  },
);

describe.skipIf(serverUrl === undefined)('once the second operator exists', () => {
  it('refuses a later self-approval once the second operator exists', async () => {
    const own = await eveRequests(w);
    expect(codeOf(await decide(w, own))).toBe('SELF_APPROVAL_REFUSED');
    expect(codeOf(await setMode(w, w.beta, w.eve, true))).toBe('SINGLE_OPERATOR_REFUSED');
  });

  it('refuses her revert ask on her own marked correction once the mode is off', async () => {
    await w.world.db.admin
      .execute(`update public.live_corrections set state = 'live' where id = $1`, [first.id])
      .catch(String);
    const asked = await asEve(w, { command: 'live_correction.revert', correctionId: first.id });
    expect(codeOf(asked)).toBe('SELF_APPROVAL_REFUSED');
  });
});
