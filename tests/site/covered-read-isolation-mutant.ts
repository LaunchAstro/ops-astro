// SPDX-License-Identifier: AGPL-3.0-only
// Test-only SQL mutation. No product files are changed.
import { expect, it, vi } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

vi.mock('../../packages/core-records/src/site/index.ts', async () => {
  const actual = await vi.importActual<
    typeof import('../../packages/core-records/src/site/index.ts')
  >('../../packages/core-records/src/site/index.ts');
  const boundary = process.env['SOL_ISOLATION_MUTANT'];
  const mutated = (tx: TenantQuery): TenantQuery => ({
    businessId: tx.businessId,
    async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
      const changed =
        boundary === 'client'
          ? sql.replace(
              "and (e.scope_kind = 'business' or (e.scope_kind = 'party' and e.scope_id = c.party_id))",
              '',
            )
          : sql.replace(
              'where s.kind = e.subject_kind and s.id = e.subject_id',
              'where s.kind = e.subject_kind',
            );
      return await tx.query<Row>(changed, parameters);
    },
  });
  return {
    ...actual,
    listCoveredCorrections: (
      tx: TenantQuery,
      ...args: Parameters<typeof actual.listCoveredCorrections> extends [TenantQuery, ...infer Rest]
        ? Rest
        : never
    ) => actual.listCoveredCorrections(mutated(tx), ...args),
    lockCoveredCorrection: (
      tx: TenantQuery,
      ...args: Parameters<typeof actual.lockCoveredCorrection> extends [TenantQuery, ...infer Rest]
        ? Rest
        : never
    ) => actual.lockCoveredCorrection(mutated(tx), ...args),
    readCoveredDecision: (
      tx: TenantQuery,
      ...args: Parameters<typeof actual.readCoveredDecision> extends [TenantQuery, ...infer Rest]
        ? Rest
        : never
    ) => actual.readCoveredDecision(mutated(tx), ...args),
  };
});

import { grantTo } from '../commands/fixture.ts';
import {
  listCoveredCorrections,
  readCoveredDecision,
} from '../../packages/core-records/src/site/index.ts';
import {
  describeLiveCorrectionLows,
  describeWorld,
  file,
  filed,
  inBusiness,
  lows,
} from './live-correction-lows.ts';
import { describeLiveCorrectionLowsRoundTwo } from './live-correction-lows-2.ts';
import { describeLiveCorrectionSolRoundOne } from './live-correction-lows-sol.ts';
describeLiveCorrectionLows();
describeLiveCorrectionLowsRoundTwo();
describeLiveCorrectionSolRoundOne();

describeWorld('Sol mutant positive control', 'sol365mutant', () => {
  it('confirms the selected isolation guard was removed through the real database reads', async () => {
    const { id } = await filed();
    const { other, taskB, clientA, clientB } = lows();
    const subjects = [{ kind: 'person' as const, id: other.personId }];
    if (process.env['SOL_ISOLATION_MUTANT'] === 'client') {
      const foreign = await file(taskB, clientB);
      if (
        typeof foreign !== 'object' ||
        foreign === null ||
        !('id' in foreign) ||
        typeof foreign.id !== 'string'
      )
        throw new Error('client B correction missing');
      const foreignId = foreign.id;
      await inBusiness(
        async (tx) =>
          await grantTo(tx, other, 'write', { kind: 'party', id: clientA }, false, 'run'),
      );
      const read = await inBusiness(
        async (tx) =>
          await readCoveredDecision(tx, foreignId, {
            subjects,
            collection: 'run',
            action: 'write',
          }),
      );
      expect(read?.correctionId).toBe(foreignId);
    } else {
      // This person has no grants. The decider's unrelated person grant now reaches them.
      const listed = await inBusiness(async (tx) => await listCoveredCorrections(tx, subjects));
      expect(listed.map((correction) => correction.id)).toContain(id);
    }
  });
});
