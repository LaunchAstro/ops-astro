// SPDX-License-Identifier: AGPL-3.0-only
//
// A correction is requested only while an approver is configured and is an
// active staff member of the business: with none, or one who has left, the
// request is refused and nothing is stored. The request share-locks the
// approver setting after its insert, so a change of the setting in flight is
// waited for, and an unset that commits first leaves the request refused.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { held, seenWaiting } from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('No approver: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('noapprover');
}, 120_000);

const storedBy = async (personId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.live_corrections
          where business_id = $1 and requested_by_person_id = $2`,
        [w.world.business, personId],
      )
    )[0]?.n,
  );

/** The setting the request reads, waited on by name in pg_stat_activity. */
const SETTING_READ = /from public\.business_settings/u;

describe.skipIf(serverUrl === undefined)('a correction request and its approver', () => {
  it('stores the request while the approver is an active staff member', async () => {
    expect(codeOf(await w.setApprover(w.ben.personId))).toBe('not-a-refusal');
    const before = await storedBy(w.ava.personId);
    expect(codeOf(await w.request(w.ava))).toBe('not-a-refusal');
    expect(await storedBy(w.ava.personId)).toBe(before + 1);
  });

  it('refuses the request and stores nothing while no approver is set', async () => {
    expect(codeOf(await w.setApprover(null))).toBe('not-a-refusal');
    const before = await storedBy(w.ava.personId);
    expect(codeOf(await w.request(w.ava))).toBe('APPROVER_NOT_CONFIGURED');
    expect(await storedBy(w.ava.personId)).toBe(before);
  });

  it('refuses the request and stores nothing once the approver has left the business', async () => {
    const leaver = await w.world.decider('leaver');
    expect(codeOf(await w.setApprover(leaver.personId))).toBe('not-a-refusal');
    await w.world.db.admin.execute(
      `update public.memberships set active = false, ended_at = now()
        where business_id = $1 and person_id = $2`,
      [w.world.business, leaver.personId],
    );
    const before = await storedBy(w.ava.personId);
    expect(codeOf(await w.request(w.ava))).toBe('APPROVER_NOT_CONFIGURED');
    expect(await storedBy(w.ava.personId)).toBe(before);
  });

  it('waits for an unset of the approver in flight, then refuses the request', async () => {
    expect(codeOf(await w.setApprover(w.ben.personId))).toBe('not-a-refusal');
    const unset = held(w, async (tx) => {
      await tx.query(
        `update public.business_settings set value = 'null'::jsonb
          where business_id = $1 and key = 'live_correction_approver'`,
        [tx.businessId],
      );
    });
    await unset.ready;
    const before = await storedBy(w.ava.personId);
    const requesting = w.request(w.ava);
    const waited = await seenWaiting(w, SETTING_READ).finally(() => unset.release());
    await unset.done;
    expect({ waited, code: codeOf(await requesting) }).toEqual({
      waited: true,
      code: 'APPROVER_NOT_CONFIGURED',
    });
    expect(await storedBy(w.ava.personId)).toBe(before);
  });
});
