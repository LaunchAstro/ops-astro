// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { grantTo } from '../commands/fixture.ts';
import { awaitParked, barrier, holdRows, racer, waitPast } from '../runtime/schedules-harness.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  lockCoveredCorrection,
  readCorrectionForRun,
  recordObservedResult,
  type ObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { describeWorld, file, filed, inBusiness, lows } from './live-correction-lows.ts';

// eslint-disable-next-line max-lines-per-function -- these ordered cases share one isolated database
describeWorld('the live correction boundaries on a real database', 'sol365r1', () => {
  it('client to client worker refusals hide inaccessible correction existence', async () => {
    const { s, taskB, clientB, leaseId, fence } = lows();
    const foreign = await file(taskB, clientB);
    if (
      typeof foreign !== 'object' ||
      foreign === null ||
      !('id' in foreign) ||
      typeof foreign.id !== 'string'
    )
      throw new Error('client B correction missing');
    const foreignId = foreign.id;
    const attempt = async (correctionId: string) => {
      const at = { correctionId, leaseId, fence, actorId: s.agentActorId };
      return await inBusiness(async (tx) => ({
        read: await readCorrectionForRun(tx, at),
        write: await recordObservedResult(tx, {
          ...at,
          step: 'publish',
          outcome: 'unknown',
          observations: {},
        }),
      }));
    };
    const own = await filed();
    expect(
      await inBusiness(
        async (tx) =>
          await readCorrectionForRun(tx, {
            correctionId: own.id,
            leaseId,
            fence,
            actorId: s.agentActorId,
          }),
      ),
    ).toMatchObject({ ok: true, correction: { id: own.id } });
    expect(await attempt(foreignId)).toStrictEqual(await attempt(randomUUID()));
  });

  it('latest publish follows receipt write order when transactions start out of order', async () => {
    const { id } = await filed('approved');
    const { s, leaseId, fence } = lows();
    const at = { correctionId: id, leaseId, fence, actorId: s.agentActorId };
    const earlierConnection = racer(s);
    const [begun, continueWriting] = [barrier(), barrier()];
    const earlierTransaction = earlierConnection.withBusiness(s.business, async (tx) => {
      await tx.query('select now()');
      begun.release();
      await continueWriting.held;
      const result: ObservedResult = {
        ...at,
        step: 'publish',
        outcome: 'unknown',
        observations: { sequence: 2 },
      };
      return await recordObservedResult(tx, result);
    });
    try {
      await begun.held;
      expect(
        await inBusiness(
          async (tx) =>
            await recordObservedResult(tx, {
              ...at,
              step: 'publish',
              outcome: 'accepted',
              observations: { sequence: 1 },
            }),
        ),
      ).toMatchObject({ ok: true, state: 'accepted' });
      continueWriting.release();
      expect(await earlierTransaction).toMatchObject({ ok: true, state: 'unknown' });
      const read = await inBusiness(async (tx) => await readCorrectionForRun(tx, at));
      expect(read).toMatchObject({
        ok: true,
        correction: { state: 'unknown' },
        lastPublish: { sequence: 2 },
      });
    } finally {
      continueWriting.release();
      await earlierTransaction.catch(() => null);
      await earlierConnection.close();
    }
  });

  for (const loss of ['revocation', 'expiry'] as const) {
    it(`person to person authority lost by ${loss} while a covered lock waits is refused`, async () => {
      const { id } = await filed();
      const { s, other, clientA } = lows();
      const grantId = await inBusiness(
        async (tx) =>
          await grantTo(tx, other, 'write', { kind: 'party', id: clientA }, false, 'run'),
      );
      const covering = {
        subjects: [{ kind: 'person' as const, id: other.personId }],
        collection: 'run',
        action: 'write',
      };
      expect(
        await inBusiness(async (tx) => await lockCoveredCorrection(tx, id, covering)),
      ).toMatchObject({ id });
      if (loss === 'expiry') {
        await s.db.admin.execute(
          "update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
          [grantId],
        );
      }
      const holder = await holdRows(s, 'live_corrections', [id]);
      const reader = racer(s);
      const reading = reader.withBusiness(
        s.business,
        async (tx) => await lockCoveredCorrection(tx, id, covering),
      );
      try {
        await awaitParked(s, 'live_corrections', 1);
        if (loss === 'revocation') {
          await inBusiness(async (tx) => await revokeGrant(tx, grantId));
        } else {
          await waitPast(s, 'select expires_at from public.grants where id = $1', grantId);
        }
        await holder.release();
        const afterWaiting = await reading;
        expect(
          await inBusiness(async (tx) => await lockCoveredCorrection(tx, id, covering)),
        ).toBeUndefined();
        expect(afterWaiting).toBeUndefined();
      } finally {
        await holder.release();
        await reading.catch(() => null);
        await reader.close();
      }
    });
  }
});

for (const boundary of ['client', 'person'] as const) {
  it(`named P26 tests detect removed ${boundary} to ${boundary} filtering`, () => {
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'tests/site/covered-read-isolation-mutant.config.mjs',
        '--reporter',
        'verbose',
      ],
      {
        env: { ...process.env, SOL_ISOLATION_MUTANT: boundary },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.stdout + run.stderr).toContain('Tests');
    expect(run.stdout + run.stderr).toContain('Sol mutant positive control');
    expect(run.stdout + run.stderr).toContain(
      `FAIL  tests/site/covered-read-isolation-mutant.ts > P26 Sol R1: the live correction records > Sol R1 ${boundary === 'client' ? '4: a client crossing' : '5: a person crossing'}`,
    );
    expect(
      run.status,
      `Isolation guard removed, named tests still green:\n${run.stdout}\n${run.stderr}`,
    ).not.toBe(0);
  }, 120_000);
}
