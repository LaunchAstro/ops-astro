// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 approver and C80 no self-approval (TR-S-R4-5): only the configured staff
// approver approves, on the exact version; any other account, the requester
// included, is refused and the correction stays where it was.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 approver: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('c80appr');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function requested(): Promise<{ correctionId: string; versionId: string }> {
  const result = await w.request(w.ava);
  expect(codeOf(result)).toBe('not-a-refusal');
  const detail = detailOf(result);
  return { correctionId: String(detail['correctionId']), versionId: String(detail['versionId']) };
}

describe.skipIf(serverUrl === undefined)('C80 approver', () => {
  it('refuses every approval while no approver is configured', async () => {
    const { correctionId, versionId } = await requested();
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe('APPROVER_NOT_CONFIGURED');
    expect(await w.stateOf(correctionId)).toBe('requested');
  });

  it('refuses a configured approver who is not an active member of the business', async () => {
    expect(codeOf(await w.setApprover(w.eve.personId))).toBe('FIELD_VALUE_INVALID');
    expect(codeOf(await w.setApprover('not-a-person'))).toBe('FIELD_VALUE_INVALID');
  });

  it('lets the configured approver approve the exact version, and nobody else', async () => {
    expect(codeOf(await w.setApprover(w.ben.personId))).toBe('not-a-refusal');
    const { correctionId, versionId } = await requested();
    expect(codeOf(await w.approve(w.cal, correctionId, versionId))).toBe(
      'APPROVER_NOT_CONFIGURED_ONE',
    );
    expect(await w.stateOf(correctionId)).toBe('requested');
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe('not-a-refusal');
    expect(await w.stateOf(correctionId)).toBe('approved');
  });
});

describe.skipIf(serverUrl === undefined)('C80 approver, version and timing', () => {
  it('refuses an approval naming another version', async () => {
    await w.setApprover(w.ben.personId);
    const { correctionId } = await requested();
    const other = '00000000-0000-4000-8000-000000000001';
    expect(codeOf(await w.approve(w.ben, correctionId, other))).toBe('VERSION_STALE');
    expect(await w.stateOf(correctionId)).toBe('requested');
  });

  it('decides once when two approvals race', async () => {
    await w.setApprover(w.ben.personId);
    const { correctionId, versionId } = await requested();
    const codes = (
      await Promise.all([
        w.approve(w.ben, correctionId, versionId),
        w.approve(w.ben, correctionId, versionId),
      ])
    ).map(codeOf);
    expect(codes.toSorted()).toEqual(['GATE_ALREADY_DECIDED', 'not-a-refusal']);
    expect(await w.stateOf(correctionId)).toBe('approved');
  });

  it('reads the approver at decision time: a change of approver before the decision binds it', async () => {
    await w.setApprover(w.ben.personId);
    const { correctionId, versionId } = await requested();
    await w.setApprover(w.cal.personId);
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe(
      'APPROVER_NOT_CONFIGURED_ONE',
    );
    expect(codeOf(await w.approve(w.cal, correctionId, versionId))).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)('C80 no self-approval', () => {
  it('refuses the requester approving their own change, even as the configured approver', async () => {
    await w.setApprover(w.ava.personId);
    const { correctionId, versionId } = await requested();
    expect(codeOf(await w.approve(w.ava, correctionId, versionId))).toBe('SELF_APPROVAL_REFUSED');
    expect(await w.stateOf(correctionId)).toBe('requested');
  });

  it('refuses a self-approval written straight to the table (the storage half)', async () => {
    const { correctionId } = await requested();
    await expect(
      w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `update public.live_corrections
              set state = 'approved', decided_by_actor_id = requested_by_actor_id,
                  decided_by_person_id = requested_by_person_id, decided_at = now()
            where id = $1`,
          [correctionId],
        );
      }),
    ).rejects.toThrow(/live_corrections_no_self_approval/u);
    expect(await w.stateOf(correctionId)).toBe('requested');
  });
});
