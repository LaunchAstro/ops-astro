// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import postgres from 'postgres';
import { grantTo } from '../commands/fixture.ts';
import { barrier, racer, waitPast } from '../runtime/schedules-harness.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  APPROVER_SETTING,
  isActiveMember,
  listCoveredCorrections,
  lockConfiguredApprover,
  lockCoveredCorrection,
  readCoveredDecision,
  writeCorrectionDecision,
} from '../../packages/core-records/src/site/index.ts';
import { describeWorld, filed, inBusiness, lows, stateOf } from './live-correction-lows.ts';

// eslint-disable-next-line max-lines-per-function -- these proofs share one isolated database
describeWorld('covered approval and reads judge the grant live', 'sol365fix1', () => {
  // eslint-disable-next-line max-lines-per-function -- the forced interleaving and cleanup share open transactions
  it('person to person revocation cannot commit between the covered check and its approval', async () => {
    const { s, other, clientA } = lows();
    const { id } = await filed();
    const grantId = await inBusiness(
      async (tx) =>
        await grantTo(tx, other, 'decide', { kind: 'party', id: clientA }, false, 'gate'),
    );
    await inBusiness(async (tx) => {
      await tx.query(
        `insert into public.business_settings
          (business_id, id, key, label, value_type, value, write_mode)
         values ($1, gen_random_uuid(), $2, 'Live correction approver', 'text',
                 to_jsonb($3::text), 'generic')`,
        [s.business, APPROVER_SETTING, other.personId],
      );
    });
    const covering = {
      subjects: [{ kind: 'person' as const, id: other.personId }],
      collection: 'gate',
      action: 'decide',
    };
    const writer = racer(s);
    const revoker = racer(s);
    const [checked, finish] = [barrier(), barrier()];
    const writing = writer.withBusiness(s.business, async (tx) => {
      const covered = await lockCoveredCorrection(tx, id, covering);
      expect(covered).toMatchObject({ id });
      expect(await lockConfiguredApprover(tx)).toBe(other.personId);
      expect(await isActiveMember(tx, other.personId)).toBe(true);
      checked.release();
      await finish.held;
      return await writeCorrectionDecision(tx, {
        id,
        decision: 'approved',
        actorId: other.actorId,
        personId: other.personId,
      });
    });
    try {
      await Promise.race([checked.held, writing]);
      let revoked = false;
      try {
        revoked = await revoker.withBusiness(s.business, async (tx) => {
          await tx.query("set local lock_timeout = '250ms'");
          return (await revokeGrant(tx, grantId)) !== null;
        });
      } catch (error) {
        if (!(error instanceof postgres.PostgresError) || error.code !== '55P03') throw error;
      }
      finish.release();
      const decision = await writing;
      expect(await stateOf(id)).toBe(decision.state);
      const after = await inBusiness(async (tx) => await lockCoveredCorrection(tx, id, covering));
      if (revoked) expect(after).toBeUndefined();
      expect({ revoked, state: decision.state }).not.toStrictEqual({
        revoked: true,
        state: 'approved',
      });
    } finally {
      finish.release();
      await writing.catch(() => null);
      await Promise.all([writer.close(), revoker.close()]);
    }
  });

  it('person to person covered reads refuse a grant expired during their transaction', async () => {
    const { s, other, clientA } = lows();
    const { id } = await filed();
    const grantId = await inBusiness(
      async (tx) => await grantTo(tx, other, 'write', { kind: 'party', id: clientA }, false, 'run'),
    );
    const covering = {
      subjects: [{ kind: 'person' as const, id: other.personId }],
      collection: 'run',
      action: 'write',
    };
    await s.db.admin.execute(
      "update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [grantId],
    );
    const reader = racer(s);
    try {
      const after = await reader.withBusiness(s.business, async (tx) => {
        expect(await readCoveredDecision(tx, id, covering)).toMatchObject({ correctionId: id });
        await waitPast(s, 'select expires_at from public.grants where id = $1', grantId);
        return {
          listed: (await listCoveredCorrections(tx, covering.subjects)).some((c) => c.id === id),
          decision: await readCoveredDecision(tx, id, covering),
          locked: await lockCoveredCorrection(tx, id, covering),
        };
      });
      expect(after.locked).toBeUndefined();
      expect(
        await inBusiness(async (tx) => await readCoveredDecision(tx, id, covering)),
      ).toBeUndefined();
      expect({ listed: after.listed, decision: after.decision }).toStrictEqual({
        listed: false,
        decision: undefined,
      });
    } finally {
      await reader.close();
    }
  });
});
