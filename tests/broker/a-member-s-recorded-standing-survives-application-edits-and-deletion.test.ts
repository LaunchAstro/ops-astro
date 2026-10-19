// SPDX-License-Identifier: AGPL-3.0-only
//
// A member's recorded standing on a run (#1909): the database stamps whether
// the proposer and each decider held the owner role as their rows are
// written, and no application edit or deletion afterwards, of the stamps, the
// decisions or the member's own membership, rewrites it.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { approve, createTask, freshPurpose, propose } from '../runtime/schedules-harness.ts';
import { s, useBrokerWorld } from './broker-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('memberstamp');

/** The world's person, who proposes and decides here, holding `role` from now on. */
async function holdsRole(role: 'owner' | 'member'): Promise<void> {
  await s.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [s.business, s.decider.personId],
  );
  await s.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [s.business, randomUUID(), s.decider.personId, role],
  );
}

/** One statement with the application's credentials, in the world's business. */
async function asApp(statement: string, parameters: unknown[]): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(statement, parameters);
  });
}

/** A version's recorded standing and its decision's, read as the application. */
async function stampsOf(versionId: unknown) {
  return await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query<{ proposed_by_owner: boolean; decided_by_owner: boolean }>(
        `select v.proposed_by_owner, d.decided_by_owner from public.proposal_versions v
       join public.gate_decisions d on d.business_id = v.business_id and d.version_id = v.id
       where v.business_id = $1 and v.id = $2`,
        [s.business, versionId],
      ),
  );
}

describe.skipIf(serverUrl === undefined)('the standing recorded for a member', () => {
  it("application edits and deletion cannot rewrite a member's recorded standing", async () => {
    await holdsRole('member');
    const task = await createTask(s, `member ${randomUUID()}`);
    const proposal = await propose(s, task, { maximumMinor: 2000, purpose: freshPurpose() });
    await approve(s, proposal);
    const version = proposal['versionId'];
    expect(Array.from(await stampsOf(version))).toStrictEqual([
      { proposed_by_owner: false, decided_by_owner: false },
    ]);
    await expect(
      asApp(
        'update public.proposal_versions set proposed_by_owner = true where business_id = $1 and id = $2',
        [s.business, version],
      ),
    ).rejects.toThrow(/cannot be edited/u);
    await expect(
      asApp(
        'update public.gate_decisions set decided_by_owner = true where business_id = $1 and version_id = $2',
        [s.business, version],
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asApp('delete from public.gate_decisions where business_id = $1 and version_id = $2', [
        s.business,
        version,
      ]),
    ).rejects.toThrow(/permission denied/u);
    await asApp('delete from public.memberships where business_id = $1 and person_id = $2', [
      s.business,
      s.decider.personId,
    ]);
    expect(Array.from(await stampsOf(version))).toStrictEqual([
      { proposed_by_owner: false, decided_by_owner: false },
    ]);
  }, 120_000);
});
